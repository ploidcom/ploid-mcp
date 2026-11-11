// The device-code flow for `ploid-mcp login` and `ploid login`. The CLI bundles this
// file, and the MCP server core is mirrored on its own, so it may import only Node
// built-ins and erased types.
import { spawn } from "node:child_process";
import { hostname, platform } from "node:os";
import type { DeviceAuthApproved, DeviceAuthStartRequest, DeviceAuthStartResponse, DeviceAuthTokenResponse } from "./contracts.js";

export class DeviceAuthError extends Error {
    constructor(
        message: string,
        readonly reason: "denied" | "expired" | "http" | "network",
        readonly status?: number,
        readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = "DeviceAuthError";
    }
}

type DeviceRequestOptions = { headers?: Record<string, string> };
type DeviceClock = { sleep: (ms: number) => Promise<void>; now: () => number };

const systemClock: DeviceClock = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
};

function deviceUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/api/auth/device${path}`;
}

function retryAfterMs(response: Response): number | undefined {
    const value = response.headers.get("retry-after");
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
            body: JSON.stringify(body),
        });
    } catch (error) {
        throw new DeviceAuthError(`Could not reach the Ploid API at ${url}: ${error instanceof Error ? error.message : String(error)}`, "network");
    }
    const text = await response.text().catch(() => "");
    let payload: unknown = null;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        payload = null;
    }
    if (!response.ok) {
        const message =
            payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
                ? payload.message
                : `Request failed (${response.status})`;
        throw new DeviceAuthError(message, "http", response.status, retryAfterMs(response));
    }
    return (payload ?? {}) as T;
}

/** Timeouts, rate limits, server errors and dropped connections clear on their own. */
function isTransient(error: DeviceAuthError): boolean {
    return error.reason === "network" || error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500;
}

/** Best-effort machine label for the browser approval page. */
export function deviceClientName(): string {
    try {
        return hostname();
    } catch {
        return "Unknown device";
    }
}

/** Opens a URL in the default browser. Best-effort: callers also print the URL for headless machines. */
export function openBrowser(url: string): void {
    const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
    const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
    try {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
    } catch {
        // No browser available.
    }
}

/** Omits `scopes`, so the key gets the default CLI scopes that both clients share through one config file. */
export function startDeviceAuth(baseUrl: string, clientName: string, options: DeviceRequestOptions = {}): Promise<DeviceAuthStartResponse> {
    const body: DeviceAuthStartRequest = { client_name: clientName };
    return postJson<DeviceAuthStartResponse>(deviceUrl(baseUrl, "/start"), body, options.headers);
}

/** Polls until the browser approves. Retries transient failures and honors `slow_down` and Retry-After. */
export async function waitForDeviceApproval(
    baseUrl: string,
    start: Pick<DeviceAuthStartResponse, "device_code" | "expires_in" | "interval">,
    options: DeviceRequestOptions & Partial<DeviceClock> = {},
): Promise<DeviceAuthApproved> {
    const { sleep, now } = { ...systemClock, ...options };
    const deadline = now() + start.expires_in * 1_000;
    let intervalMs = Math.max(1, start.interval) * 1_000;
    while (now() < deadline) {
        await sleep(intervalMs);
        let token: DeviceAuthTokenResponse;
        try {
            token = await postJson<DeviceAuthTokenResponse>(deviceUrl(baseUrl, "/token"), { device_code: start.device_code }, options.headers);
        } catch (error) {
            if (!(error instanceof DeviceAuthError) || !isTransient(error)) throw error;
            intervalMs = Math.min(30_000, Math.max(intervalMs + 2_000, error.retryAfterMs ?? 0));
            continue;
        }
        if (token.status === "pending") continue;
        if (token.status === "slow_down") {
            intervalMs += 2_000;
            continue;
        }
        if (token.status === "denied") throw new DeviceAuthError("Login was denied in the browser.", "denied");
        if (token.status === "expired") break;
        if (token.status === "approved" && typeof token.api_key === "string") return token;
        throw new DeviceAuthError("Ploid returned an unexpected device authorization response.", "http");
    }
    throw new DeviceAuthError("Login expired. Run the command again.", "expired");
}

export async function browserLogin(baseUrl: string, open = true): Promise<string> {
    const start = await startDeviceAuth(baseUrl, `MCP · ${deviceClientName()}`);
    process.stderr.write(`Open ${start.verification_uri_complete}\nCode: ${start.user_code}\n`);
    if (open) openBrowser(start.verification_uri_complete);
    process.stderr.write("Waiting for browser approval…\n");
    return (await waitForDeviceApproval(baseUrl, start)).api_key;
}
