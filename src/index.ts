import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { log } from './log.js'

const port = Number(process.env.PORT) || 3000
serve({ fetch: createApp().fetch, port }, (info) => {
  log('server_started', {
    port: info.port,
    ploidMode: process.env.PLOID_MODE ?? 'mock',
    authMode: process.env.AUTH_MODE ?? 'dev',
  })
})
