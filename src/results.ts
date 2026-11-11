import { PloidApiError, PloidRunEndedError } from "./api.js";

/** MCP tool results shared by the person and Sets handlers. */
export type ToolResult = {
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
};

export function errorResult(text: string, error?: unknown, runId?: string): ToolResult {
    const cause = error instanceof PloidRunEndedError ? error.cause : error;
    const apiError = cause instanceof PloidApiError ? cause : undefined;
    const payload = apiError?.payload;
    const status = payload?.error?.code === "run_cancelled" ? "cancelled" : payload?.error?.status;
    return {
        isError: status !== "cancelled",
        content: [{ type: "text", text: payload ? `${text}\n\nAPI details:\n${json(payload)}` : text }],
        ...(apiError
            ? {
                  structuredContent: {
                      ...payload,
                      http_status: apiError.status,
                      ...(status === "failed" || status === "cancelled" ? { status } : {}),
                      ...(runId ? { run_id: runId } : {}),
                  },
              }
            : {}),
    };
}

export function json(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

/** `progress` is one sentence on where the run stands (queue place, people found so far). */
export function pendingResult(runId: string, status: string, retryAfterSeconds: number, extra: Record<string, unknown> = {}, progress?: string): ToolResult {
    return {
        content: [
            {
                type: "text",
                text: `Research is ${status}. Run ID: ${runId}. ${progress ? `${progress} ` : ""}This is not a research result. Call get_research_status with this run_id after at least ${retryAfterSeconds} seconds. The job continues if this MCP call or client disconnects.`,
            },
        ],
        structuredContent: {
            status,
            run_id: runId,
            retry_after_seconds: retryAfterSeconds,
            next: { tool: "get_research_status", arguments: { run_id: runId } },
            ...extra,
        },
    };
}

export function cancelledResult(runId: string, details: Record<string, unknown> = {}): ToolResult {
    return {
        content: [{ type: "text", text: `Research run ${runId} was cancelled. Stop polling this run.\n\n${json(details)}` }],
        structuredContent: { ...details, status: "cancelled", run_id: runId },
    };
}

export function notActiveResult(runId: string): ToolResult {
    return {
        content: [{ type: "text", text: `Run ${runId} is no longer active, so there was nothing to cancel. Call get_research_status for its final result.` }],
        structuredContent: { status: "not_active", run_id: runId },
    };
}
