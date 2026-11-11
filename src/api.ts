import { createHash } from "node:crypto";
import { z } from "zod";
import { resolveConfig } from "./config.js";

export type PloidMcpOptions = {
    apiKey?: string;
    baseUrl?: string;
    /** Server-only authenticated caller/grant ID, stable across HTTP retries and token refreshes. */
    idempotencyScope?: string;
    /** Server-only headers for a trusted upstream hop. Never populate this from MCP client input. */
    requestHeaders?: Record<string, string>;
};

export type ApiResult = { data: unknown; meta: Record<string, unknown> };

/**
 * Fields K of contract type T as a tolerant response parser reads them: each may be
 * missing or null. Parsers `satisfies z.ZodType<…>` these views, so a renamed or
 * retyped contract field fails typecheck.
 */
export type Tolerant<T, K extends keyof T> = { [P in K]?: T[P] | null };
/**
 * Like {@link Tolerant}, but enum strings read as any string, so values a newer API adds still display.
 * Fields that are not strings or string arrays map to `never`, so retyping one still fails typecheck.
 */
export type TolerantStrings<T, K extends keyof T> = {
    [P in K]?: (NonNullable<T[P]> extends string ? string : NonNullable<T[P]> extends readonly string[] ? string[] : never) | null;
};

export class PloidApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code?: string,
        readonly payload?: z.infer<typeof ApiEnvelopeSchema>,
    ) {
        super(message);
    }
}

/** Ploid could not be reached, or the connection dropped before the response arrived. */
export class PloidNetworkError extends Error {
    constructor(cause: unknown) {
        super(`Could not reach Ploid${cause instanceof Error && cause.message ? ` (${cause.message})` : ""}.`, { cause });
    }
}

/** The run has ended, so checking its status again returns the same error. */
export class PloidRunEndedError extends Error {}

/** Timeouts, network errors, rate limits and server errors clear on their own; the run keeps going. */
export function isTransient(error: unknown): boolean {
    if (error instanceof PloidApiError) return error.status >= 500 || error.status === 429;
    return (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) || error instanceof PloidNetworkError;
}

const ApiEnvelopeSchema = z
    .object({
        data: z.unknown().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
        error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
    })
    .passthrough();

function connection(options: PloidMcpOptions) {
    const local = options.baseUrl && (options.apiKey || options.requestHeaders) ? undefined : resolveConfig();
    const apiKey = options.apiKey ?? local?.apiKey;
    const baseUrl = (options.baseUrl ?? local?.baseUrl ?? "https://api.ploid.com").replace(/\/+$/, "");
    if (!apiKey && !options.requestHeaders) {
        throw new Error("Ploid is not connected. Sign in through your MCP client or set PLOID_API_KEY.");
    }
    const headers = {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.requestHeaders,
    };
    return { baseUrl, headers };
}

export function authenticatedRequestScope(options: PloidMcpOptions, session: string): string {
    // Hosted OAuth uses its stable grant's API-key ID, never the rotating access
    // token or per-process loopback capability. Standalone clients use the key.
    const principal = options.idempotencyScope
        ? ["principal", options.idempotencyScope]
        : ["credential", new Headers(connection(options).headers).get("authorization")];
    if (!principal[1]) throw new Error("Hosted MCP connections require an authenticated idempotency scope.");
    // Credentials only enter the hash; they are never sent as a key or returned.
    return JSON.stringify([principal, session]);
}

export function mcpIdempotencyKey(requestId: string | number, operation: string, body: unknown, requestScope = ""): string {
    const digest = createHash("sha256").update(JSON.stringify({ requestScope, requestId, operation, body })).digest("hex").slice(0, 32);
    return `mcp:${digest}`;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

function requestSignal(signal?: AbortSignal, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): AbortSignal {
    const deadline = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function send(url: string, init: RequestInit): Promise<{ response: Response; body: unknown }> {
    try {
        const response = await fetch(url, init);
        return { response, body: parseJson(await response.text()) };
    } catch (error) {
        // fetch rejects with a TypeError for network failures; timeouts and aborts keep their DOMException.
        if (error instanceof TypeError) throw new PloidNetworkError(error);
        throw error;
    }
}

export async function callApi(
    options: PloidMcpOptions,
    method: "GET" | "POST" | "DELETE",
    // Always a path built here from validated IDs: never send credentials to a caller-supplied URL.
    path: string,
    init: { signal?: AbortSignal; body?: unknown; idempotencyKey?: string; timeoutMs?: number } = {},
): Promise<ApiResult> {
    const { baseUrl, headers } = connection(options);
    const { response, body } = await send(`${baseUrl}${path}`, {
        method,
        headers: { ...headers, ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: requestSignal(init.signal, init.timeoutMs),
        redirect: "error",
    });
    const parsed = ApiEnvelopeSchema.safeParse(body);
    if (!response.ok || (parsed.success && parsed.data.error)) {
        const error = parsed.success ? parsed.data.error : undefined;
        throw new PloidApiError(
            error?.message ?? `Ploid request failed (${response.status}).`,
            response.status,
            error?.code,
            parsed.success ? parsed.data : undefined,
        );
    }
    if (!parsed.success) throw new Error(`Ploid returned an invalid response (${response.status}).`);
    return { data: parsed.data.data, meta: parsed.data.meta ?? {} };
}

export function errorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PloidApiError && error.code === "insufficient_scope") {
        return `${message} Reconnect Ploid in your MCP client, or run \`ploid-mcp login\` again for a local server, to grant the people:enrich and people:search permissions.`;
    }
    return message;
}
