import './env'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { bearerAuth } from './auth'
import { chatRoutes } from './routes/chat'
import { uiRoutes } from './routes/ui'
import { workspaceRoutes } from './routes/workspace'

const app = new Hono()

app.use('*', logger())

// Frontend UI routes
app.route('/', uiRoutes())

// POST /chat
app.use('/chat', bearerAuth())
app.use('/chat/*', bearerAuth())
app.route('/', chatRoutes())

// Workspace API routes
app.use('/workspace/*', bearerAuth())
app.route('/', workspaceRoutes())

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

const port = Number(process.env.PORT ?? 3000)

serve({
  fetch: app.fetch,
  port,
})

console.log(`sandboxed-coding-agent listening on http://localhost:${port}`)
