import {
  createOpencodeClient,
  type Event as OpencodeEvent,
  type Session,
} from '@opencode-ai/sdk'
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

type SessionPromptParams = Parameters<ReturnType<typeof createOpencodeClient>['session']['prompt']>[0]
type SessionPromptResponseData = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createOpencodeClient>['session']['prompt']>>['data']
>

// OpenCode tools config uses booleans as enabled/disabled flags.
// Setting a tool to false disables it and can lead to "pretend" tool usage in text.
const CHAT_TOOLS_ENABLED: Record<string, boolean> = {
  question: true,
  bash: true,
  read: true,
  glob: true,
  grep: true,
  edit: true,
  write: true,
  task: true,
  webfetch: true,
  todowrite: true,
  websearch: true,
  codesearch: true,
  skill: true,
  apply_patch: true,
}

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
    console.log('[pilot] --> session.create')
    try {
      const result = await this.client.session.create({ throwOnError: true })
      console.log('[pilot] <-- session.create', { id: result.data.id })
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

  private buildPromptPayload(
    sessionId: string,
    message: string,
    opts: ChatOptions,
  ): SessionPromptParams {
    return {
      path: { id: sessionId },
      body: {
        model: {
          modelID: opts.modelID,
          providerID: opts.providerID,
        },
        tools: CHAT_TOOLS_ENABLED,
        system: buildSystemPrompt(opts.system, opts.username),
        parts: [{ type: 'text', text: message }],
      },
    }
  }

  async sendPrompt(
    sessionId: string,
    message: string,
    opts: ChatOptions,
  ): Promise<SessionPromptResponseData> {
    const promptPayload = this.buildPromptPayload(sessionId, message, opts)
    console.log('[pilot] --> session.prompt', {
      sessionId,
      modelID: opts.modelID,
      providerID: opts.providerID,
      messageLength: message.length,
    })

    try {
      const result = await this.client.session.prompt({
        ...promptPayload,
        throwOnError: true,
      })
      if (!result.data) {
        throw new Error('Prompt response did not include assistant message data')
      }
      console.log('[pilot] <-- session.prompt', {
        messageId: result.data.info?.id,
        partCount: Array.isArray(result.data.parts) ? result.data.parts.length : 0,
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

  async sendPromptAsync(
    sessionId: string,
    message: string,
    opts: ChatOptions,
  ): Promise<void> {
    const promptPayload = this.buildPromptPayload(sessionId, message, opts)
    console.log('[pilot] --> session.promptAsync', {
      sessionId,
      modelID: opts.modelID,
      providerID: opts.providerID,
      messageLength: message.length,
    })

    try {
      await this.client.session.promptAsync({
        ...promptPayload,
        throwOnError: true,
      })
      console.log('[pilot] <-- session.promptAsync (accepted)')
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
    const result = await this.client.event.subscribe({ signal })
    return result.stream
  }

  async listChatOptions(): Promise<ChatOptionsCatalog> {
    console.log('[pilot] --> provider.list')
    try {
      const result = await this.client.provider.list({ throwOnError: true })
      console.log('[pilot] <-- provider.list', { providerCount: Array.isArray(result.data?.all) ? result.data.all.length : 0 })

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
    if (opts.stream === false) {
      try {
        const promptResult = await this.sendPrompt(sessionId, message, opts)
        if (!promptResult) {
          throw new Error('Prompt response did not include assistant message data')
        }

        yield {
          type: 'message.updated',
          properties: {
            info: promptResult.info,
          },
        }
        for (const part of promptResult.parts) {
          yield {
            type: 'message.part.updated',
            properties: {
              part,
            },
          }
        }
        yield {
          type: 'session.idle',
          properties: {
            sessionID: sessionId,
          },
        }
      } catch (err) {
        if (err instanceof OpencodePilotError) {
          throw err
        }
        if (isConnectionError(err)) {
          throw new OpencodePilotError(
            `Cannot connect to opencode event stream: ${normalizeError(err).message}`,
            err,
          )
        }
        throw normalizeError(err)
      }
      return
    }

    const streamController = new AbortController()
    const stream = await this.subscribe(streamController.signal)
    let promptError: unknown

    try {
      let pending = stream.next()

      const promptPromise = this.sendPromptAsync(sessionId, message, opts).catch((err) => {
        promptError = err
        streamController.abort()
        throw err
      })

      while (true) {
        const next = await pending
        if (next.done) break

        const event = next.value
        const relevant = isEventForSession(event, sessionId)
        pending = stream.next()
        if (!relevant) continue

        yield event

        if (event.type === 'session.idle' || event.type === 'session.error') {
          break
        }
      }

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
      streamController.abort()
    }
  }
}

function isEventForSession(event: OpencodeEvent, sessionId: string): boolean {
  switch (event.type) {
    case 'session.created':
      return event.properties.info.id === sessionId

    case 'session.idle':
      return event.properties.sessionID === sessionId

    case 'session.error':
      return event.properties.sessionID === sessionId || event.properties.sessionID === undefined

    case 'session.status':
    case 'session.compacted':
    case 'session.diff':
    case 'todo.updated':
    case 'command.executed':
    case 'permission.replied':
      return event.properties.sessionID === sessionId

    case 'session.updated':
    case 'session.deleted':
      return event.properties.info.id === sessionId

    case 'message.updated':
      return (event.properties.info as { sessionID: string }).sessionID === sessionId

    case 'message.removed':
    case 'message.part.removed':
      return event.properties.sessionID === sessionId

    case 'message.part.updated':
      return (event.properties.part as { sessionID: string }).sessionID === sessionId

    case 'permission.updated':
      return (event.properties as { sessionID: string }).sessionID === sessionId

    case 'file.edited':
    case 'installation.updated':
    case 'installation.update-available':
    case 'lsp.client.diagnostics':
    case 'file.watcher.updated':
    case 'server.instance.disposed':
    case 'server.connected':
    case 'tui.prompt.append':
    case 'tui.command.execute':
    case 'tui.toast.show':
    case 'vcs.branch.updated':
    case 'pty.created':
    case 'pty.updated':
    case 'pty.exited':
    case 'pty.deleted':
      return true

    default:
      return false
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
