const apiKeyInput = document.getElementById('apiKeyInput')
const connectButton = document.getElementById('connectButton')
const refreshWorkspaceButton = document.getElementById('refreshWorkspaceButton')
const connectionStatus = document.getElementById('connectionStatus')
const workspaceTree = document.getElementById('workspaceTree')
const fileMeta = document.getElementById('fileMeta')
const fileContent = document.getElementById('fileContent')
const chatLog = document.getElementById('chatLog')
const chatForm = document.getElementById('chatForm')
const modelInput = document.getElementById('modelInput')
const providerInput = document.getElementById('providerInput')
const usernameInput = document.getElementById('usernameInput')
const systemInput = document.getElementById('systemInput')
const streamToggle = document.getElementById('streamToggle')
const messageInput = document.getElementById('messageInput')
const sendButton = document.getElementById('sendButton')
const sessionBadge = document.getElementById('sessionBadge')

const STORAGE_KEYS = {
  apiKey: 'sandboxed-agent-api-key',
  modelID: 'sandboxed-model-id',
  providerID: 'sandboxed-provider-id',
  username: 'sandboxed-username',
  systemPrompt: 'sandboxed-system-prompt',
  streamEnabled: 'sandboxed-stream-enabled',
  sessionID: 'sandboxed-session-id',
}

const WORKSPACE_REFRESH_DEBOUNCE_MS = 300
const WORKSPACE_POLL_INTERVAL_MS = 2500
const MAX_TOOL_CHIPS_PER_MESSAGE = 24
const TOOL_CHIP_STATUS_CLASSES = [
  'tool-chip-pending',
  'tool-chip-running',
  'tool-chip-completed',
  'tool-chip-error',
]

const state = {
  selectedFilePath: '',
  sessionId: localStorage.getItem(STORAGE_KEYS.sessionID) ?? '',
  streaming: false,
  providerCatalog: new Map(),
  assistantByMessageID: new Map(),
  messageRoles: new Map(),
  userMessageIDs: new Set(),
  workspaceLoading: false,
  workspaceDirty: false,
  workspaceRefreshTimer: null,
  workspacePollTimer: null,
  lastWorkspaceError: '',
}

function setSelectValueWithFallback(select, value) {
  if (!value) {
    return
  }

  const hasOption = Array.from(select.options).some((option) => option.value === value)
  if (!hasOption) {
    const customOption = document.createElement('option')
    customOption.value = value
    customOption.textContent = `${value} (custom)`
    select.appendChild(customOption)
  }

  select.value = value
}

function normalizeChatOptionsCatalog(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.providers)) {
    return []
  }

  const providers = []
  for (const provider of payload.providers) {
    const id = typeof provider?.id === 'string' ? provider.id.trim() : ''
    if (!id) continue

    const name = typeof provider?.name === 'string' && provider.name.trim()
      ? provider.name.trim()
      : id
    const connected = Boolean(provider?.connected)
    const defaultModelID =
      typeof provider?.defaultModelID === 'string' && provider.defaultModelID.trim()
        ? provider.defaultModelID.trim()
        : ''

    const models = []
    if (Array.isArray(provider?.models)) {
      for (const model of provider.models) {
        const modelID = typeof model?.id === 'string' ? model.id.trim() : ''
        if (!modelID) continue
        const modelName =
          typeof model?.name === 'string' && model.name.trim()
            ? model.name.trim()
            : modelID
        models.push({ id: modelID, name: modelName })
      }
    }

    if (models.length === 0) continue

    providers.push({
      id,
      name,
      connected,
      defaultModelID,
      models,
    })
  }

  return providers
}

function applyProviderCatalog(providers) {
  state.providerCatalog = new Map()
  providerInput.textContent = ''

  for (const provider of providers) {
    state.providerCatalog.set(provider.id, provider)

    const option = document.createElement('option')
    option.value = provider.id
    option.textContent = provider.connected ? provider.id : `${provider.id} (not connected)`
    providerInput.appendChild(option)
  }

  if (providers.length === 0) {
    return
  }

  const storedProviderID = localStorage.getItem(STORAGE_KEYS.providerID) ?? ''
  const currentProviderID = providerInput.value.trim()
  const connectedProviderID = providers.find((provider) => provider.connected)?.id ?? ''
  const selectedProviderID =
    providers.some((provider) => provider.id === storedProviderID)
      ? storedProviderID
      : providers.some((provider) => provider.id === currentProviderID)
        ? currentProviderID
        : connectedProviderID || providers[0].id

  providerInput.value = selectedProviderID
  renderModelOptionsForProvider(selectedProviderID)
}

function renderModelOptionsForProvider(providerID, preferredModelID = '') {
  modelInput.textContent = ''

  const provider = state.providerCatalog.get(providerID)
  if (!provider) {
    return
  }

  for (const model of provider.models) {
    const option = document.createElement('option')
    option.value = model.id
    option.textContent = model.name === model.id ? model.id : `${model.id} (${model.name})`
    modelInput.appendChild(option)
  }

  if (provider.models.length === 0) {
    return
  }

  const storedModelID = localStorage.getItem(STORAGE_KEYS.modelID) ?? ''
  const currentModelID = modelInput.value.trim()
  const desiredModelID = preferredModelID || storedModelID || currentModelID

  const defaultModelID =
    provider.defaultModelID && provider.models.some((model) => model.id === provider.defaultModelID)
      ? provider.defaultModelID
      : ''

  const selectedModelID =
    provider.models.some((model) => model.id === desiredModelID)
      ? desiredModelID
      : defaultModelID || provider.models[0].id

  modelInput.value = selectedModelID
}

function applyFallbackChatOptions() {
  if (providerInput.options.length === 0) {
    setSelectValueWithFallback(providerInput, localStorage.getItem(STORAGE_KEYS.providerID) ?? 'openai')
  }
  if (modelInput.options.length === 0) {
    setSelectValueWithFallback(modelInput, localStorage.getItem(STORAGE_KEYS.modelID) ?? 'gpt-4o')
  }
}

async function loadChatOptions(options = {}) {
  if (!hasApiKey()) {
    return
  }

  const silent = Boolean(options.silent)

  try {
    const response = await authedFetch('/chat/options')
    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    const payload = await response.json()
    const providers = normalizeChatOptionsCatalog(payload)
    if (providers.length === 0) {
      throw new Error('No models available from opencode server.')
    }

    applyProviderCatalog(providers)
  } catch (error) {
    applyFallbackChatOptions()
    if (!silent) {
      const message = error instanceof Error ? error.message : 'Failed to load provider/model options.'
      appendChatMessage('system', `Model options refresh failed: ${message}`)
    }
  }
}

apiKeyInput.value = localStorage.getItem(STORAGE_KEYS.apiKey) ?? ''
usernameInput.value = localStorage.getItem(STORAGE_KEYS.username) ?? ''
systemInput.value = localStorage.getItem(STORAGE_KEYS.systemPrompt) ?? ''
{
  const savedStreamPreference = localStorage.getItem(STORAGE_KEYS.streamEnabled)
  streamToggle.checked = savedStreamPreference === null ? true : savedStreamPreference === '1'
}
updateSessionBadge()
applyFallbackChatOptions()

connectButton.addEventListener('click', async () => {
  localStorage.setItem(STORAGE_KEYS.apiKey, apiKeyInput.value.trim())
  await Promise.all([
    loadWorkspace(),
    loadChatOptions(),
  ])
  if (hasApiKey()) {
    startWorkspaceAutoRefresh()
  }
})

refreshWorkspaceButton.addEventListener('click', async () => {
  await loadWorkspace()
})

apiKeyInput.addEventListener('input', () => {
  if (hasApiKey()) {
    startWorkspaceAutoRefresh()
    void loadChatOptions({ silent: true })
    return
  }
  stopWorkspaceAutoRefresh()
})

providerInput.addEventListener('change', () => {
  const providerID = providerInput.value.trim()
  renderModelOptionsForProvider(providerID, '')
})

streamToggle.addEventListener('change', () => {
  localStorage.setItem(STORAGE_KEYS.streamEnabled, streamToggle.checked ? '1' : '0')
})

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  await sendMessage()
})

messageInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
    return
  }

  event.preventDefault()
  void sendMessage()
})

if (apiKeyInput.value.trim()) {
  void loadWorkspace()
  void loadChatOptions({ silent: true })
  startWorkspaceAutoRefresh()
}

function setStatus(message, tone = 'neutral') {
  connectionStatus.textContent = message
  connectionStatus.className = `status status-${tone}`
}

function updateSessionBadge() {
  sessionBadge.textContent = state.sessionId
    ? `Session: ${state.sessionId.slice(0, 12)}...`
    : 'Session: not started'
}

function getApiKey() {
  const key = apiKeyInput.value.trim()
  if (!key) {
    throw new Error('API key is required.')
  }
  return key
}

function normalizeToolName(toolName) {
  if (typeof toolName !== 'string' || toolName.trim() === '') {
    return 'tool'
  }

  const compact = toolName.trim().toLowerCase().replace(/\s+/g, '')
  const alias = {
    todowrite: 'todo write',
    applypatch: 'apply patch',
    webfetch: 'web fetch',
    websearch: 'web search',
    codesearch: 'code search',
  }

  const raw = alias[compact] ?? toolName
  return raw
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function setToolChipStatus(chip, status) {
  if (!chip) {
    return
  }

  chip.classList.remove(...TOOL_CHIP_STATUS_CLASSES)

  if (status === 'running') {
    chip.classList.add('tool-chip-running')
    return
  }
  if (status === 'completed') {
    chip.classList.add('tool-chip-completed')
    return
  }
  if (status === 'error') {
    chip.classList.add('tool-chip-error')
    return
  }

  chip.classList.add('tool-chip-pending')
}

function getOrCreateAssistantEntry(messageID) {
  let entry = state.assistantByMessageID.get(messageID)
  if (entry) {
    return entry
  }

  const block = document.createElement('div')
  block.className = 'chat-assistant-block'

  const toolRow = document.createElement('div')
  toolRow.className = 'chat-tool-row'
  toolRow.hidden = true

  const messageElement = document.createElement('div')
  messageElement.className = 'chat-message chat-assistant'
  messageElement.hidden = true

  block.appendChild(toolRow)
  block.appendChild(messageElement)
  chatLog.appendChild(block)

  entry = {
    parts: new Map(),
    messageElement,
    toolRow,
    toolByCallID: new Map(),
    toolCallOrder: [],
  }
  state.assistantByMessageID.set(messageID, entry)
  return entry
}

function upsertAssistantToolPart(part) {
  const messageID = typeof part?.messageID === 'string' ? part.messageID : ''
  const callID =
    typeof part?.callID === 'string' && part.callID
      ? part.callID
      : typeof part?.id === 'string'
        ? part.id
        : ''
  const toolName = typeof part?.tool === 'string' ? part.tool : ''

  if (!messageID || !callID || !toolName) {
    return
  }

  const role = state.messageRoles.get(messageID)
  if (role === 'user' || state.userMessageIDs.has(messageID)) {
    return
  }

  const entry = getOrCreateAssistantEntry(messageID)

  let chip = entry.toolByCallID.get(callID)
  if (!chip) {
    chip = document.createElement('span')
    chip.className = 'tool-chip'
    chip.textContent = normalizeToolName(toolName)
    chip.title = toolName
    entry.toolRow.appendChild(chip)
    entry.toolByCallID.set(callID, chip)
    entry.toolCallOrder.push(callID)

    while (entry.toolCallOrder.length > MAX_TOOL_CHIPS_PER_MESSAGE) {
      const oldestCallID = entry.toolCallOrder.shift()
      if (!oldestCallID) continue
      const oldestChip = entry.toolByCallID.get(oldestCallID)
      if (oldestChip) {
        oldestChip.remove()
      }
      entry.toolByCallID.delete(oldestCallID)
    }
  }

  entry.toolRow.hidden = false
  const status = typeof part?.state?.status === 'string' ? part.state.status : 'pending'
  setToolChipStatus(chip, status)
  chatLog.scrollTop = chatLog.scrollHeight
}

function hasApiKey() {
  return apiKeyInput.value.trim().length > 0
}

async function authedFetch(url, options = {}) {
  const headers = new Headers(options.headers ?? {})
  headers.set('Authorization', `Bearer ${getApiKey()}`)
  return fetch(url, { ...options, headers })
}

async function readErrorMessage(response) {
  try {
    const payload = await response.json()
    if (payload && typeof payload.error === 'string') {
      return payload.error
    }
  } catch {}
  return `Request failed (${response.status})`
}

function createTreeList(nodes, depth = 0, expandedDirectories = null) {
  const list = document.createElement('ul')
  list.className = 'tree-list'

  for (const node of nodes) {
    const item = document.createElement('li')
    item.className = 'tree-item'

    if (node.type === 'directory') {
      const details = document.createElement('details')
      details.dataset.dirPath = node.path
      details.open = expandedDirectories ? expandedDirectories.has(node.path) : depth <= 1

      const summary = document.createElement('summary')
      summary.textContent = node.name
      details.appendChild(summary)

      if (Array.isArray(node.children) && node.children.length > 0) {
        details.appendChild(createTreeList(node.children, depth + 1, expandedDirectories))
      }

      item.appendChild(details)
      list.appendChild(item)
      continue
    }

    const fileButton = document.createElement('button')
    fileButton.type = 'button'
    fileButton.className = 'tree-file'
    fileButton.dataset.filePath = node.path
    fileButton.textContent = node.name
    fileButton.addEventListener('click', () => {
      void loadFile(node.path)
    })

    item.appendChild(fileButton)
    list.appendChild(item)
  }

  return list
}

function updateSelectedFileStyle() {
  for (const button of workspaceTree.querySelectorAll('.tree-file')) {
    button.classList.toggle('selected', button.dataset.filePath === state.selectedFilePath)
  }
}

function captureExpandedDirectories() {
  const expanded = new Set()
  for (const details of workspaceTree.querySelectorAll('details[open]')) {
    const dirPath = details.dataset.dirPath
    if (dirPath) {
      expanded.add(dirPath)
    }
  }
  return expanded
}

function requestWorkspaceRefresh(options = {}) {
  if (!hasApiKey()) {
    return
  }

  if (options.immediate) {
    void loadWorkspace({ silent: true })
    return
  }

  if (state.workspaceRefreshTimer !== null) {
    window.clearTimeout(state.workspaceRefreshTimer)
  }

  state.workspaceRefreshTimer = window.setTimeout(() => {
    state.workspaceRefreshTimer = null
    void loadWorkspace({ silent: true })
  }, WORKSPACE_REFRESH_DEBOUNCE_MS)
}

function startWorkspaceAutoRefresh() {
  if (state.workspacePollTimer !== null) {
    return
  }

  state.workspacePollTimer = window.setInterval(() => {
    if (!hasApiKey() || document.hidden) {
      return
    }
    void loadWorkspace({ silent: true })
  }, WORKSPACE_POLL_INTERVAL_MS)
}

function stopWorkspaceAutoRefresh() {
  if (state.workspacePollTimer !== null) {
    window.clearInterval(state.workspacePollTimer)
    state.workspacePollTimer = null
  }
  if (state.workspaceRefreshTimer !== null) {
    window.clearTimeout(state.workspaceRefreshTimer)
    state.workspaceRefreshTimer = null
  }
}

window.addEventListener('beforeunload', stopWorkspaceAutoRefresh)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    requestWorkspaceRefresh({ immediate: true })
  }
})

function normalizePathForCompare(filePath) {
  if (typeof filePath !== 'string') {
    return ''
  }
  return filePath.replace(/\\/g, '/')
}

function matchesSelectedFilePath(filePath) {
  if (!state.selectedFilePath) {
    return false
  }

  const selected = normalizePathForCompare(state.selectedFilePath)
  const candidate = normalizePathForCompare(filePath)
  return candidate === selected || candidate.endsWith(`/${selected}`)
}

function isDeleteChange(changeType) {
  return changeType === 'remove' || changeType === 'deleted' || changeType === 'unlink'
}

function clearSelectedFilePreview(message) {
  state.selectedFilePath = ''
  fileMeta.textContent = 'Preview unavailable'
  fileContent.textContent = message
  updateSelectedFileStyle()
}

async function loadWorkspace(options = {}) {
  if (state.workspaceLoading) {
    state.workspaceDirty = true
    return
  }

  const silent = Boolean(options.silent)
  state.workspaceLoading = true

  try {
    if (!silent) {
      setStatus('Loading workspace...', 'working')
    }

    const response = await authedFetch('/workspace/tree')

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    const payload = await response.json()
    const expandedDirectories = captureExpandedDirectories()
    workspaceTree.textContent = ''

    if (!Array.isArray(payload.nodes) || payload.nodes.length === 0) {
      const placeholder = document.createElement('p')
      placeholder.textContent = 'No files found in workspace.'
      workspaceTree.appendChild(placeholder)
    } else {
      workspaceTree.appendChild(createTreeList(payload.nodes, 0, expandedDirectories))
      updateSelectedFileStyle()
    }

    if (!silent) {
      if (payload.truncated) {
        setStatus(
          `Connected. Workspace loaded (truncated at ${payload.maxEntries} entries or depth ${payload.maxDepth}).`,
          'ok',
        )
      } else {
        setStatus('Connected. Workspace loaded.', 'ok')
      }
    }
    state.lastWorkspaceError = ''
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load workspace.'
    if (!silent || message !== state.lastWorkspaceError) {
      setStatus(message, 'error')
    }
    state.lastWorkspaceError = message
  } finally {
    state.workspaceLoading = false
    if (state.workspaceDirty) {
      state.workspaceDirty = false
      void loadWorkspace({ silent: true })
    }
  }
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

async function loadFile(filePath) {
  try {
    const response = await authedFetch(`/workspace/file?path=${encodeURIComponent(filePath)}`)
    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    const payload = await response.json()
    state.selectedFilePath = payload.path
    fileMeta.textContent = `${payload.path} (${formatBytes(payload.size)})`
    fileContent.textContent = payload.content
    updateSelectedFileStyle()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load file.'
    fileMeta.textContent = 'Preview unavailable'
    fileContent.textContent = message
  }
}

function appendChatMessage(kind, text) {
  const message = document.createElement('div')
  message.className = `chat-message chat-${kind}`
  message.textContent = text
  chatLog.appendChild(message)
  chatLog.scrollTop = chatLog.scrollHeight
  return message
}

function upsertAssistantText(messageID, partID, text) {
  const entry = getOrCreateAssistantEntry(messageID)
  entry.parts.set(partID, text)
  const content = Array.from(entry.parts.values()).join('')
  entry.messageElement.textContent = content
  entry.messageElement.hidden = content.length === 0
  chatLog.scrollTop = chatLog.scrollHeight
}

function handleStreamEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    return
  }

  if (event.type === 'message.updated') {
    const info = event.properties?.info
    if (info && typeof info.id === 'string' && typeof info.role === 'string') {
      state.messageRoles.set(info.id, info.role)
      if (info.role === 'user') {
        state.userMessageIDs.add(info.id)
      }
    }
    return
  }

  if (event.type === 'message.part.updated') {
    const part = event.properties?.part
    if (!part) {
      return
    }

    if (part.type === 'tool') {
      upsertAssistantToolPart(part)
      return
    }

    if (part.type !== 'text') {
      return
    }

    const messageID = typeof part.messageID === 'string' ? part.messageID : ''
    const partID = typeof part.id === 'string' ? part.id : ''
    const text = typeof part.text === 'string' ? part.text : ''
    if (!messageID || !partID) {
      return
    }

    const role = state.messageRoles.get(messageID)
    if (role === 'user' || state.userMessageIDs.has(messageID)) {
      return
    }

    upsertAssistantText(messageID, partID, text)
    return
  }

  if (event.type === 'session.error') {
    appendChatMessage('system', 'Session reported an error.')
    return
  }

  if (event.type === 'file.edited' && typeof event.properties?.file === 'string') {
    if (matchesSelectedFilePath(event.properties.file)) {
      void loadFile(state.selectedFilePath)
    }
    requestWorkspaceRefresh()
    return
  }

  if (event.type === 'file.watcher.updated') {
    const changedPath = typeof event.properties?.file === 'string' ? event.properties.file : ''
    const changeType =
      typeof event.properties?.event === 'string' ? event.properties.event.toLowerCase() : ''

    if (changedPath && matchesSelectedFilePath(changedPath)) {
      if (isDeleteChange(changeType)) {
        clearSelectedFilePreview('File was deleted from workspace.')
      } else {
        void loadFile(state.selectedFilePath)
      }
    }

    requestWorkspaceRefresh()
    return
  }
}

function handleEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.type !== 'string') {
    return
  }

  if (envelope.type === 'session.created' && typeof envelope.sessionId === 'string') {
    state.sessionId = envelope.sessionId
    localStorage.setItem(STORAGE_KEYS.sessionID, state.sessionId)
    updateSessionBadge()
    return
  }

  if (envelope.type === 'event') {
    handleStreamEvent(envelope.event)
    return
  }

  if (envelope.type === 'error') {
    appendChatMessage('system', envelope.message || 'Request failed.')
    return
  }
}

function processSSEBlock(block) {
  if (!block) return

  const dataLines = []
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (dataLines.length === 0) {
    return
  }

  try {
    const envelope = JSON.parse(dataLines.join('\n'))
    handleEnvelope(envelope)
  } catch {
    appendChatMessage('system', 'Received malformed stream data.')
  }
}

async function streamChatResponse(response) {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Streaming is unavailable in this browser.')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '')
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      processSSEBlock(block)
    }
  }

  if (buffer.trim()) {
    processSSEBlock(buffer)
  }
}

async function sendMessage() {
  if (state.streaming) {
    return
  }

  const message = messageInput.value.trim()
  if (!message) {
    return
  }

  const modelID = modelInput.value.trim()
  const providerID = providerInput.value.trim()
  const username = usernameInput.value.trim()
  const system = systemInput.value.trim()
  const stream = streamToggle.checked

  if (!modelID || !providerID) {
    appendChatMessage('system', 'modelID and providerID are required.')
    return
  }

  try {
    getApiKey()
  } catch (error) {
    appendChatMessage('system', error instanceof Error ? error.message : 'API key is required.')
    return
  }

  localStorage.setItem(STORAGE_KEYS.modelID, modelID)
  localStorage.setItem(STORAGE_KEYS.providerID, providerID)
  localStorage.setItem(STORAGE_KEYS.username, username)
  localStorage.setItem(STORAGE_KEYS.systemPrompt, system)
  localStorage.setItem(STORAGE_KEYS.streamEnabled, stream ? '1' : '0')

  appendChatMessage('user', message)
  messageInput.value = ''
  state.streaming = true
  sendButton.disabled = true
  streamToggle.disabled = true

  try {
    const payload = {
      sessionId: state.sessionId || undefined,
      message,
      modelID,
      providerID,
      stream,
      username: username || undefined,
      system: system || undefined,
    }

    const response = await authedFetch('/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    await streamChatResponse(response)
  } catch (error) {
    appendChatMessage('system', error instanceof Error ? error.message : 'Chat request failed.')
  } finally {
    state.streaming = false
    sendButton.disabled = false
    streamToggle.disabled = false
    requestWorkspaceRefresh()
  }
}
