import Opencode from '@opencode-ai/sdk'
import type { Session, AssistantMessage } from '@opencode-ai/sdk/resources/session'
import type { EventListResponse } from '@opencode-ai/sdk/resources/event'
import type { Stream } from '@opencode-ai/sdk/core/streaming'
import { APIConnectionError, APIConnectionTimeoutError } from '@opencode-ai/sdk/core/error'
import { WORKSPACE_ROOT } from '../workspace/config'

export class OpencodePilotError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'OpencodePilotError'
  }
}

export interface ChatOptions {
  modelID: string
  providerID: string
  stream?: boolean
  username?: string
  system?: string
}

export interface ChatModelOption {
  id: string
  name: string
}

export interface ChatProviderOption {
  id: string
  name: string
  connected: boolean
  defaultModelID?: string
  models: ChatModelOption[]
}

export interface ChatOptionsCatalog {
  providers: ChatProviderOption[]
}

export class SandboxPilot {
  readonly client: Opencode

  constructor(opts?: { baseURL?: string }) {
    const baseURL = opts?.baseURL ?? process.env.OPENCODE_BASE_URL ?? 'http://localhost:54321'
    const opencodePassword = process.env.OPENCODE_SERVER_PASSWORD
    const opencodeUsername = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'
    const defaultHeaders: Record<string, string> = {
      'x-opencode-directory': WORKSPACE_ROOT,
    }

    if (opencodePassword) {
      const encoded = Buffer.from(`${opencodeUsername}:${opencodePassword}`, 'utf8').toString('base64')
      defaultHeaders.Authorization = `Basic ${encoded}`
    }

    this.client = new Opencode({
      baseURL,
      defaultHeaders,
    })
  }

  async createSession(): Promise<Session> {
    try {
      return await this.client.session.create()
    } catch (err) {
      if (err instanceof APIConnectionError || err instanceof APIConnectionTimeoutError) {
        throw new OpencodePilotError(
          `Cannot reach opencode server: ${(err as Error).message}`,
          err,
        )
      }
      throw err
    }
  }

  async chat(
    sessionId: string,
    message: string,
    opts: ChatOptions,
  ): Promise<AssistantMessage> {
    try {
      return await this.client.session.chat(sessionId, {
        modelID: opts.modelID,
        providerID: opts.providerID,
        system: buildSystemPrompt(opts.system, opts.username),
        parts: [{ type: 'text', text: message }],
      })
    } catch (err) {
      if (err instanceof APIConnectionError || err instanceof APIConnectionTimeoutError) {
        throw new OpencodePilotError(
          `Cannot reach opencode server: ${(err as Error).message}`,
          err,
        )
      }
      throw err
    }
  }

  async subscribe(): Promise<Stream<EventListResponse>> {
    try {
      return await this.client.event.list()
    } catch (err) {
      if (err instanceof APIConnectionError || err instanceof APIConnectionTimeoutError) {
        throw new OpencodePilotError(
          `Cannot connect to opencode event stream: ${(err as Error).message}`,
          err,
        )
      }
      throw err
    }
  }

  async listChatOptions(): Promise<ChatOptionsCatalog> {
    try {
      const result = await this.client.app.providers()
      const defaults =
        result.default && typeof result.default === 'object'
          ? (result.default as Record<string, unknown>)
          : {}
      const providersRaw = Array.isArray(result.providers) ? result.providers : []

      const providers: ChatProviderOption[] = []

      for (const provider of providersRaw) {
        const providerID = typeof provider.id === 'string' ? provider.id.trim() : ''
        if (!providerID) {
          continue
        }

        const providerName =
          typeof provider.name === 'string' && provider.name.trim()
            ? provider.name.trim()
            : providerID

        const modelEntries =
          provider.models && typeof provider.models === 'object'
            ? Object.entries(provider.models)
            : []

        const models: ChatModelOption[] = modelEntries
          .map(([modelID, modelValue]) => {
            const modelName =
              modelValue && typeof modelValue === 'object' && 'name' in modelValue
                ? (modelValue as { name?: unknown }).name
                : undefined

            return {
              id: modelID,
              name:
                typeof modelName === 'string' && modelName.trim()
                  ? modelName.trim()
                  : modelID,
            }
          })
          .sort((a, b) => a.id.localeCompare(b.id))

        if (models.length === 0) {
          continue
        }

        const defaultModelID = defaults[providerID]
        const item: ChatProviderOption = {
          id: providerID,
          name: providerName,
          connected: true,
          models,
        }

        if (typeof defaultModelID === 'string' && defaultModelID.trim()) {
          item.defaultModelID = defaultModelID
        }

        providers.push(item)
      }

      providers.sort((a, b) => a.id.localeCompare(b.id))
      return { providers }
    } catch (err) {
      if (err instanceof APIConnectionError || err instanceof APIConnectionTimeoutError) {
        throw new OpencodePilotError(
          `Cannot reach opencode server: ${(err as Error).message}`,
          err,
        )
      }
      throw err
    }
  }

  async *chatAndStream(
    sessionId: string,
    message: string,
    opts: ChatOptions,
  ): AsyncGenerator<EventListResponse> {
    if (opts.stream === false) {
      const stream = await this.subscribe()
      const bufferedEvents: EventListResponse[] = []
      let reachedTerminal = false

      try {
        await this.chat(sessionId, message, opts)

        for await (const event of stream) {
          const relevant = isEventForSession(event, sessionId)
          if (!relevant) continue

          bufferedEvents.push(event)

          if (event.type === 'session.idle' || event.type === 'session.error') {
            reachedTerminal = true
            break
          }
        }
      } finally {
        stream.controller.abort()
      }

      if (!reachedTerminal) {
        bufferedEvents.push({
          type: 'session.idle',
          properties: {
            sessionID: sessionId,
          },
        })
      }

      for (const event of bufferedEvents) {
        yield event
      }
      return
    }

    // 1. Subscribe FIRST so we miss no events
    const stream = await this.subscribe()

    try {
      // 2. Send the chat message
      await this.chat(sessionId, message, opts)

      // 3. Iterate events, filter by sessionId, yield matching ones
      for await (const event of stream) {
        const relevant = isEventForSession(event, sessionId)
        if (!relevant) continue

        yield event

        // 4. Break on terminal events (after yielding them)
        if (event.type === 'session.idle' || event.type === 'session.error') {
          break
        }
      }
    } finally {
      // 5. Always abort the underlying HTTP stream
      stream.controller.abort()
    }
  }
}

function buildSystemPrompt(system: string | undefined, username: string | undefined): string | undefined {
  const base = typeof system === 'string' ? system.trim() : ''
  const normalizedUsername = typeof username === 'string' ? username.trim() : ''

  if (!normalizedUsername) {
    return base || undefined
  }

  const userContext = `Current username: ${normalizedUsername}`
  return base ? `${base}\n\n${userContext}` : userContext
}

/**
 * Returns true if the event belongs to (or should pass through for) the given sessionId.
 */
function isEventForSession(event: EventListResponse, sessionId: string): boolean {
  switch (event.type) {
    case 'session.idle':
      return event.properties.sessionID === sessionId

    case 'session.error':
      // sessionID is optional on session.error
      return event.properties.sessionID === sessionId || event.properties.sessionID === undefined

    case 'session.updated':
    case 'session.deleted':
      return event.properties.info.id === sessionId

    case 'message.updated': {
      const info = event.properties.info
      // Message has sessionID on both UserMessage and AssistantMessage
      return (info as { sessionID: string }).sessionID === sessionId
    }

    case 'message.removed':
      return event.properties.sessionID === sessionId

    case 'permission.updated':
      return event.properties.sessionID === sessionId

    // Pass-through events — global agent activity, always include
    case 'message.part.updated':
    case 'message.part.removed':
    case 'file.edited':
    case 'installation.updated':
    case 'ide.installed':
    case 'lsp.client.diagnostics':
    case 'storage.write':
    case 'file.watcher.updated':
      return true

    default:
      return false
  }
}
