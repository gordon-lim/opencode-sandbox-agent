import {
  createOpencodeClient,
  type AssistantMessage,
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

const CHAT_TOOLS_DISABLED: Record<string, boolean> = {
  question: false,
  bash: false,
  read: false,
  glob: false,
  grep: false,
  edit: false,
  write: false,
  task: false,
  webfetch: false,
  todowrite: false,
  websearch: false,
  codesearch: false,
  skill: false,
  apply_patch: false,
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
    try {
      const result = await this.client.session.create({ throwOnError: true })
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
        tools: CHAT_TOOLS_DISABLED,
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

    try {
      const result = await this.client.session.prompt({
        ...promptPayload,
        throwOnError: true,
      })
      if (!result.data) {
        throw new Error('Prompt response did not include assistant message data')
      }
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

  async listChatOptions(): Promise<ChatOptionsCatalog> {
    try {
      const result = await this.client.provider.list({ throwOnError: true })

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
    try {
      const promptResult = await this.sendPrompt(sessionId, message, opts)
      if (!promptResult) {
        throw new Error('Prompt response did not include assistant message data')
      }
      const promptParts = await this.getPromptPartsWithRetry(
        sessionId,
        promptResult.info.id,
        promptResult.parts,
      )

      yield {
        type: 'message.updated',
        properties: {
          info: promptResult.info,
        },
      }

      const preferDeltas = opts.stream !== false
      for (const part of promptParts) {
        if (!(preferDeltas && part.type === 'text' && part.text)) {
          yield {
            type: 'message.part.updated',
            properties: {
              part,
            },
          }
          continue
        }

        let textSoFar = ''
        for (const delta of splitTextIntoDeltas(part.text)) {
          textSoFar += delta
          yield {
            type: 'message.part.updated',
            properties: {
              part: {
                ...part,
                text: textSoFar,
              },
              delta,
            },
          }
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
  }

  private async getPromptPartsWithRetry(
    sessionId: string,
    messageID: string,
    initialParts: SessionPromptResponseData['parts'],
    maxAttempts = 12,
  ): Promise<SessionPromptResponseData['parts']> {
    if (Array.isArray(initialParts) && initialParts.length > 0) {
      return initialParts
    }

    let latestParts: SessionPromptResponseData['parts'] = Array.isArray(initialParts)
      ? initialParts
      : []
    let lastError: unknown

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const result = await this.client.session.message({
          path: { id: sessionId, messageID },
          throwOnError: true,
        })
        const parts = Array.isArray(result.data.parts) ? result.data.parts : []
        latestParts = parts
        if (parts.length > 0) {
          return parts
        }
      } catch (err) {
        if (isConnectionError(err)) {
          throw new OpencodePilotError(
            `Cannot reach opencode server: ${normalizeError(err).message}`,
            err,
          )
        }
        lastError = err
      }

      if (attempt < maxAttempts - 1) {
        await sleep(Math.min(120 + attempt * 40, 500))
      }
    }

    if (latestParts.length === 0 && lastError) {
      throw normalizeError(lastError)
    }
    return latestParts
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

function splitTextIntoDeltas(text: string, maxChunkSize = 56): string[] {
  if (!text) {
    return ['']
  }

  const deltas: string[] = []
  let cursor = 0

  while (cursor < text.length) {
    deltas.push(text.slice(cursor, cursor + maxChunkSize))
    cursor += maxChunkSize
  }

  return deltas
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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
