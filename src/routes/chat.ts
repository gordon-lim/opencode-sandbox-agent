import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { SandboxPilot, OpencodePilotError } from '../sandbox/pilot'

interface ChatRequestBody {
  sessionId?: string
  message: string
  modelID: string
  providerID: string
  stream?: boolean
  username?: string
  system?: string
}

type SSEEnvelope =
  | { type: 'session.created'; sessionId: string }
  | { type: 'event'; event: unknown }
  | { type: 'done' }
  | { type: 'error'; message: string; code: string }

function sseData(envelope: SSEEnvelope): string {
  return `data: ${JSON.stringify(envelope)}\n\n`
}

export function chatRoutes() {
  const router = new Hono()

  router.get('/chat/options', async (c) => {
    const pilot = new SandboxPilot()

    try {
      const options = await pilot.listChatOptions()
      return c.json(options)
    } catch (err) {
      if (err instanceof OpencodePilotError) {
        return c.json(
          { error: err.message, code: 'OPENCODE_UNREACHABLE' },
          502,
        )
      }
      const message = err instanceof Error ? err.message : 'Unexpected error'
      return c.json({ error: message, code: 'INTERNAL_ERROR' }, 500)
    }
  })

  router.post('/chat', async (c) => {
    let body: ChatRequestBody

    try {
      body = await c.req.json<ChatRequestBody>()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!body.message || typeof body.message !== 'string') {
      return c.json({ error: 'message is required and must be a string' }, 400)
    }
    if (!body.modelID || typeof body.modelID !== 'string') {
      return c.json({ error: 'modelID is required and must be a string' }, 400)
    }
    if (!body.providerID || typeof body.providerID !== 'string') {
      return c.json({ error: 'providerID is required and must be a string' }, 400)
    }
    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
      return c.json({ error: 'stream must be a boolean when provided' }, 400)
    }
    if (body.username !== undefined && typeof body.username !== 'string') {
      return c.json({ error: 'username must be a string when provided' }, 400)
    }

    const pilot = new SandboxPilot()

    return stream(c, async (s) => {
      c.header('Content-Type', 'text/event-stream')
      c.header('Cache-Control', 'no-cache')
      c.header('X-Accel-Buffering', 'no')

      try {
        let sessionId: string

        if (body.sessionId) {
          sessionId = body.sessionId
        } else {
          const session = await pilot.createSession()
          sessionId = session.id
          await s.write(sseData({ type: 'session.created', sessionId }))
        }

        for await (const event of pilot.chatAndStream(sessionId, body.message, {
          modelID: body.modelID,
          providerID: body.providerID,
          stream: body.stream,
          username: body.username,
          system: body.system,
        })) {
          await s.write(sseData({ type: 'event', event }))
        }
      } catch (err) {
        if (err instanceof OpencodePilotError) {
          await s.write(
            sseData({ type: 'error', message: err.message, code: 'OPENCODE_UNREACHABLE' }),
          )
        } else {
          const message = err instanceof Error ? err.message : 'Unexpected error'
          await s.write(sseData({ type: 'error', message, code: 'INTERNAL_ERROR' }))
        }
      } finally {
        try {
          await s.write(sseData({ type: 'done' }))
        } catch {
          // No-op: client may have disconnected before terminal envelope flush.
        }
      }
    })
  })

  return router
}
