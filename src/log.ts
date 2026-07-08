/** Structured JSON-lines logging to stdout. One event per line. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
}
