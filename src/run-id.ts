/** MCP run ids carry the kind of job so status and cancel can reach the right endpoint. */
export type RunKind = "person" | "set";
export type RunRef = { kind: RunKind; id: string };

const PREFIXES: Record<RunKind, string> = { person: "person-", set: "set-" };
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function formatRunId(kind: RunKind, id: string): string {
    return `${PREFIXES[kind]}${id}`;
}

export function parseRunId(runId: string): RunRef | null {
    for (const kind of Object.keys(PREFIXES) as RunKind[]) {
        const prefix = PREFIXES[kind];
        if (runId.startsWith(prefix) && runId.length > prefix.length) return { kind, id: runId.slice(prefix.length) };
    }
    return null;
}
