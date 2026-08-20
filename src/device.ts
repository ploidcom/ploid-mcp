import { spawn } from "node:child_process";
import { hostname, platform } from "node:os";

type DeviceStart = {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

type DeviceToken =
  | { status: "pending" | "slow_down" | "denied" | "expired"; interval?: number }
  | { status: "approved"; api_key: string };

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : `Request failed (${response.status})`);
  return payload as T;
}

function openBrowser(url: string): void {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is also printed for headless environments.
  }
}

export async function browserLogin(baseUrl: string, open = true): Promise<string> {
  const authBase = `${baseUrl}/api/auth/device`;
  const start = await postJson<DeviceStart>(`${authBase}/start`, {
    client_name: `MCP · ${hostname()}`,
    scopes: ["agent:chat", "account:read"],
  });
  process.stderr.write(`Open ${start.verification_uri_complete}\nCode: ${start.user_code}\n`);
  if (open) openBrowser(start.verification_uri_complete);
  process.stderr.write("Waiting for browser approval…\n");

  const deadline = Date.now() + start.expires_in * 1000;
  let intervalMs = Math.max(1, start.interval) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const token = await postJson<DeviceToken>(`${authBase}/token`, { device_code: start.device_code });
    if (token.status === "pending") continue;
    if (token.status === "slow_down") {
      intervalMs += 2_000;
      continue;
    }
    if (token.status === "denied") throw new Error("Login was denied in the browser.");
    if (token.status === "expired") throw new Error("Login expired. Run the command again.");
    if (token.status === "approved") return token.api_key;
    throw new Error("Ploid returned an unexpected device authorization response.");
  }
  throw new Error("Login expired. Run the command again.");
}
