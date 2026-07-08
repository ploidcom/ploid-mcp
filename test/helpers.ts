import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'

/**
 * Test helpers. Each test file runs in its own process (node --test), so
 * setting process.env at the top of a file (before importing src modules
 * that read it) safely configures that file's server.
 */

export interface TestServer {
  url: string
  close: () => Promise<void>
}

/** Starts the real app on an ephemeral port. Import createApp lazily so env vars set by the caller apply. */
export async function startServer(): Promise<TestServer> {
  const { createApp } = await import('../src/app.js')
  const app = createApp()
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info: AddressInfo) => {
      resolve({
        url: `http://localhost:${info.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/** JSON-RPC tool call against a running server. Returns the parsed result. */
export async function callTool(
  baseUrl: string,
  name: string,
  args: Record<string, unknown>,
  token?: string
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const res = await rpc(baseUrl, 'tools/call', { name, arguments: args }, token)
  const result = (res as { result: { isError?: boolean; content: Array<{ text: string }> } }).result
  return {
    isError: result.isError ?? false,
    payload: JSON.parse(result.content[0].text) as Record<string, unknown>,
  }
}

export async function rpc(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
  token?: string
): Promise<unknown> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return res.json()
}

export async function form(
  url: string,
  fields: Record<string, string>
): Promise<{ status: number; location: string; body: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
  return { status: res.status, location: res.headers.get('location') ?? '', body: await res.text() }
}
