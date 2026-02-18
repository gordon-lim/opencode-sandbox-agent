import {
  createOpencodeClient,
  type AssistantMessage,
  type Event as OpencodeEvent,
  type Session,
} from '@opencode-ai/sdk/v2'
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

type SessionPromptParams = Parameters<ReturnType<typeof createOpencodeClient>['session']['prompt']>[0]

export class SandboxPilot {
  readonly client: ReturnType<typeof createOpencodeClient>

  constructor(opts?: { baseURL?: string }) {
    const baseUrl = opts?.baseURL ?? process.env.OPENCODE_BASE_URL ?? 'http://localhost:54321'
    const opencodePassword = process.env.OPENCODE_SERVER_PASSWORD
    const opencodeUsername = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'
    const headers: Record<string, string> = {
      'x-opencode-directory': WORKSPACE_ROOT,
    }

    if (opencodePassword) {
      const encoded = Buffer.from(`${opencodeUsername}:${opencodePassword}`, 'utf8').toString('base64')
      headers.Authorization = `Basic ${encoded}`
    }

    this.client = createOpencodeClient({
      baseUrl,
      headers,
    })
  }

  async createSession(): Promise<Session> {
    try {
      const result = await this.client.session.create(undefined, {
        throwOnError: true,
      })
      return result.data
    } catch (err) {
      if (isConnectionError(err)) {
        throw new OpencodePilotError(
          `Cannot reach opencode server: ${normalizeError(err).message}`,
          err,
        )
      }
      throw normalizeError(err)
    }
  }

  async chat(
    sessionId: string,
    message: string,
    opts: ChatOptions,
  ): Promise<AssistantMessage> {
    const promptPayload = {
      sessionID: sessionId,
      model: {
        modelID: opts.modelID,
        providerID: opts.providerID,
      },
      system: buildSystemPrompt(opts.system, opts.username),
      parts: [{ type: 'text', text: message }],
    } satisfies SessionPromptParams

    try {
      const result = await this.client.session.prompt(promptPayload, {
        throwOnError: true,
      })
      return result.data.info
    } catch (err) {
      if (isConnectionError(err)) {
        throw new OpencodePilotError(
          `Cannot reach opencode server: ${normalizeError(err).message}`,
          err,
        )
      }
      throw normalizeError(err)
    }
  }

  async subscribe(signal: AbortSignal): Promise<AsyncGenerator<OpencodeEvent>> {
    const result = await this.client.event.subscribe(undefined, { signal })
    return result.stream
  }

  async listChatOptions(): Promise<ChatOptionsCatalog> {
    try {
      const result = await this.client.provider.list(undefined, {
        throwOnError: true,
      })

      const data = result.data
      const connected = new Set(Array.isArray(data.connected) ? data.connected : [])
      const defaults =
        data.default && typeof data.default === 'object'
          ? (data.default as Record<string, unknown>)
          : {}

      const all = Array.isArray(data.all) ? data.all : []
      const providers: ChatProviderOption[] = []

      for (const provider of all) {
        const providerID = typeof provider.id === 'string' ? provider.id : ''
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
          connected: connected.has(providerID),
          models,
        }

        if (typeof defaultModelID === 'string' && defaultModelID.trim()) {
          item.defaultModelID = defaultModelID
        }

        providers.push(item)
      }

      providers.sort((a, b) => {
        if (a.connected !== b.connected) {
          return a.connected ? -1 : 1
        }
        return a.id.localeCompare(b.id)
      })

      return { providers }
    } catch (err) {
      if (isConnectionError(err)) {
        throw new OpencodePilotError(
          `Cannot reach opencode server: ${normalizeError(err).message}`,
          err,
        )
      }
      throw normalizeError(err)
    }
  }

  async *chatAndStream(
    sessionId: string,
    message: string,
    opts: ChatOptions,
  ): AsyncGenerator<OpencodeEvent> {
    // 1. Subscribe FIRST so we miss no events
    const streamController = new AbortController()
    const stream = await this.subscribe(streamController.signal)
    let promptError: unknown

    try {
      // Kick off stream consumption immediately (v2 SSE stream is lazy).
      // This ensures /event starts before we send the prompt.
      let pending = stream.next()

      // 2. Send the chat message in parallel.
      const promptPromise = this.chat(sessionId, message, opts).catch((err) => {
        promptError = err
        // If prompt fails, stop waiting on the stream.
        streamController.abort()
        throw err
      })

      // 3. Iterate events, filter by sessionId, yield matching ones.
      while (true) {
        const next = await pending
        if (next.done) {
          break
        }

        const event = next.value
        const relevant = isEventForSession(event, sessionId)
        pending = stream.next()
        if (!relevant) continue

        yield event

        // 4. Break on terminal events (after yielding them)
        if (event.type === 'session.idle' || event.type === 'session.error') {
          break
        }
      }

      // 5. Surface prompt failures after streaming terminal event(s).
      await promptPromise
    } catch (err) {
      const rootErr = promptError ?? err
      if (rootErr instanceof OpencodePilotError) {
        throw rootErr
      }
      if (isConnectionError(rootErr)) {
        throw new OpencodePilotError(
          `Cannot connect to opencode event stream: ${normalizeError(rootErr).message}`,
          rootErr,
        )
      }
      throw normalizeError(rootErr)
    } finally {
      // Always abort the underlying HTTP stream.
      streamController.abort()
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
function isEventForSession(event: OpencodeEvent, sessionId: string): boolean {
  switch (event.type) {
    case 'session.created':
    case 'session.idle':
      return event.type === 'session.created'
        ? event.properties.info.id === sessionId
        : event.properties.sessionID === sessionId

    case 'session.error':
      // sessionID is optional on session.error
      return event.properties.sessionID === sessionId || event.properties.sessionID === undefined

    case 'session.status':
    case 'session.compacted':
    case 'session.diff':
    case 'todo.updated':
    case 'command.executed':
    case 'permission.asked':
    case 'permission.replied':
    case 'question.asked':
    case 'question.replied':
    case 'question.rejected':
      return event.properties.sessionID === sessionId

    case 'session.updated':
    case 'session.deleted':
      return event.properties.info.id === sessionId

    case 'message.updated':
      // Message has sessionID on both UserMessage and AssistantMessage.
      return event.properties.info.sessionID === sessionId
    case 'message.removed':
    case 'message.part.delta':
    case 'message.part.removed':
      return event.properties.sessionID === sessionId

    case 'message.part.updated':
      return event.properties.part.sessionID === sessionId

    // Pass-through events — global agent activity, always include
    case 'file.edited':
    case 'installation.updated':
    case 'installation.update-available':
    case 'lsp.client.diagnostics':
    case 'file.watcher.updated':
    case 'project.updated':
    case 'server.instance.disposed':
    case 'server.connected':
    case 'global.disposed':
    case 'tui.prompt.append':
    case 'tui.command.execute':
    case 'tui.toast.show':
    case 'tui.session.select':
    case 'mcp.tools.changed':
    case 'mcp.browser.open.failed':
    case 'vcs.branch.updated':
    case 'pty.created':
    case 'pty.updated':
    case 'pty.exited':
    case 'pty.deleted':
    case 'worktree.ready':
    case 'worktree.failed':
      return true

    default:
      return false
  }
}

function normalizeError(err: unknown): Error {
  if (err instanceof Error) {
    return err
  }

  const message = extractErrorMessage(err)
  if (message) {
    return new Error(message)
  }

  try {
    return new Error(JSON.stringify(err))
  } catch {
    return new Error('Unknown opencode error')
  }
}

function extractErrorMessage(err: unknown): string {
  if (typeof err === 'string') {
    return err
  }

  if (!err || typeof err !== 'object') {
    return ''
  }

  const direct = err as { message?: unknown; data?: unknown }
  if (typeof direct.message === 'string' && direct.message.trim()) {
    return direct.message
  }

  if (direct.data && typeof direct.data === 'object') {
    const nestedMessage = (direct.data as { message?: unknown }).message
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage
    }
  }

  return ''
}

function isConnectionError(err: unknown): boolean {
  const normalized = normalizeError(err)
  const message = normalized.message.toLowerCase()

  return (
    normalized.name === 'AbortError' ||
    normalized.name === 'TypeError' ||
    message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('sse failed')
  )
}
