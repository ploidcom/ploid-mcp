import type { HttpBindings } from '@hono/node-server'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bearerAuth, createTokenVerifier, protectedResourceMetadata } from './auth.js'
import type { AuthContext } from './auth.js'
import { buildMcpServer } from './mcp.js'
import {
  authorizationServerMetadata,
  authorizePage,
  authorizeSubmit,
  registerClient,
  tokenEndpoint,
} from './oauth.js'
import { createPloidClient } from './ploid/client.js'

type Env = { Bindings: HttpBindings; Variables: { auth: AuthContext } }

/** Builds the Hono app. Reads AUTH_MODE and friends at call time. */
export function createApp() {
  const app = new Hono<Env>()

  // Browser-based clients (MCP Inspector, claude.ai) need CORS on /mcp and
  // on the discovery/OAuth endpoints.
  app.use(
    '*',
    cors({
      origin: (origin) => origin,
      allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
      exposeHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
    })
  )

  app.get('/healthz', (c) => c.json({ ok: true }))

  // OAuth discovery + built-in authorization server (see src/oauth.ts): lets
  // Claude/ChatGPT users connect by pasting their Ploid API key.
  app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata)
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata)
  app.get('/.well-known/oauth-authorization-server', authorizationServerMetadata)
  app.get('/.well-known/oauth-authorization-server/mcp', authorizationServerMetadata)
  app.post('/register', registerClient)
  app.get('/authorize', authorizePage)
  app.post('/authorize', authorizeSubmit)
  app.post('/token', tokenEndpoint)

  const verifier = createTokenVerifier()
  app.use('/mcp', bearerAuth(verifier))

  app.post('/mcp', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined)
    if (body === undefined) {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON' }, id: null },
        400
      )
    }

    // Stateless mode: a fresh server + transport per request, no session IDs.
    // Any instance behind the load balancer can serve any request.
    const server = buildMcpServer(createPloidClient(c.get('auth')))
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    c.env.outgoing.on('close', () => {
      void transport.close()
      void server.close()
    })

    await server.connect(transport)
    await transport.handleRequest(c.env.incoming, c.env.outgoing, body)
    return RESPONSE_ALREADY_SENT
  })

  // Stateless server: no SSE streams to resume, no sessions to delete.
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null },
      405,
      { Allow: 'POST' }
    )
  )

  return app
}
