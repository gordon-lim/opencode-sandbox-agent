import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT_DIR = path.resolve(__dirname, '..')

function loadIfExists(fileName) {
  const filePath = path.join(ROOT_DIR, fileName)

  try {
    process.loadEnvFile(filePath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw error
  }
}

// Higher-priority env files are loaded first because loadEnvFile does not override existing vars.
loadIfExists('.env.local')
loadIfExists('.env.opencode.local')
loadIfExists('.env.opencode')
loadIfExists('.env')
loadIfExists('.env.example')
loadIfExists('.env.opencode.example')

const baseURLRaw = process.env.OPENCODE_BASE_URL ?? 'http://localhost:54321'
let baseURL
try {
  baseURL = new URL(baseURLRaw)
} catch {
  console.error(`[dev] Invalid OPENCODE_BASE_URL: ${baseURLRaw}`)
  process.exit(1)
}

if (!['http:', 'https:'].includes(baseURL.protocol)) {
  console.error(`[dev] OPENCODE_BASE_URL must use http/https: ${baseURLRaw}`)
  process.exit(1)
}

const hostname = baseURL.hostname || '127.0.0.1'
const defaultOpencodePort = baseURL.protocol === 'https:' ? 443 : 80

if (baseURL.pathname !== '/' || baseURL.search || baseURL.hash) {
  console.warn(
    `[dev] OPENCODE_BASE_URL has a path/query/hash. Only host/port are used to start opencode: ${baseURLRaw}`,
  )
}

const childEnv = { ...process.env }
const workspaceRoot = path.resolve(ROOT_DIR, process.env.WORKSPACE_ROOT ?? 'sandbox_workspace')
mkdirSync(workspaceRoot, { recursive: true })
const appArgs = ['--watch', '--import', 'tsx', 'src/index.ts']

function parsePort(rawPort, fallbackPort) {
  const parsed = Number.parseInt(String(rawPort ?? ''), 10)
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
    return parsed
  }
  return fallbackPort
}

function canListenOnPort(candidatePort, host) {
  return new Promise((resolve, reject) => {
    const tester = createServer()
    tester.unref()

    tester.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
          resolve(false)
          return
        }
      }
      reject(error)
    })

    tester.listen(candidatePort, host, () => {
      tester.close(() => resolve(true))
    })
  })
}

async function findAvailablePort(startPort, maxAttempts = 100, label = 'port', host) {
  let portToTry = startPort
  const endPort = Math.min(65_535, startPort + maxAttempts - 1)

  while (portToTry <= endPort) {
    if (await canListenOnPort(portToTry, host)) {
      return portToTry
    }
    portToTry += 1
  }

  throw new Error(`Could not find an available ${label} in range ${startPort}-${endPort}`)
}

const preferredOpencodePort = parsePort(baseURL.port, defaultOpencodePort)
const selectedOpencodePort = await findAvailablePort(
  preferredOpencodePort,
  100,
  'opencode port',
  hostname,
)
const selectedOpencodeBaseURL = `${baseURL.protocol}//${hostname}:${selectedOpencodePort}`
childEnv.OPENCODE_BASE_URL = selectedOpencodeBaseURL
const opencodeArgs = ['serve', `--hostname=${hostname}`, `--port=${selectedOpencodePort}`]

if (selectedOpencodePort !== preferredOpencodePort) {
  console.warn(
    `[dev] opencode port ${preferredOpencodePort} is unavailable; using ${selectedOpencodePort}`,
  )
}

const preferredAppPort = parsePort(childEnv.PORT, 3000)
const selectedAppPort = await findAvailablePort(preferredAppPort, 100, 'app port')
childEnv.PORT = String(selectedAppPort)

if (selectedAppPort !== preferredAppPort) {
  console.warn(`[dev] app port ${preferredAppPort} is unavailable; using ${selectedAppPort}`)
}

console.log(`[dev] opencode workspace: ${workspaceRoot}`)
console.log(`[dev] starting opencode: opencode ${opencodeArgs.join(' ')}`)
const opencodeProc = spawn('opencode', opencodeArgs, {
  cwd: workspaceRoot,
  env: childEnv,
  stdio: 'inherit',
})

console.log(`[dev] starting app: node ${appArgs.join(' ')}`)
const appProc = spawn(process.execPath, appArgs, {
  cwd: ROOT_DIR,
  env: childEnv,
  stdio: 'inherit',
})

const children = [opencodeProc, appProc]
let shuttingDown = false

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM')
    }
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill('SIGKILL')
      }
    }
    process.exit(exitCode)
  }, 750).unref()
}

opencodeProc.on('error', (error) => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    console.error('[dev] opencode binary not found. Install opencode runtime first.')
  } else {
    console.error('[dev] failed to start opencode:', error)
  }
  shutdown(1)
})

appProc.on('error', (error) => {
  console.error('[dev] failed to start app process:', error)
  shutdown(1)
})

opencodeProc.on('exit', (code, signal) => {
  if (shuttingDown) return
  const status = typeof code === 'number' ? code : 1
  console.error(`[dev] opencode exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
  shutdown(status)
})

appProc.on('exit', (code, signal) => {
  if (shuttingDown) return
  const status = typeof code === 'number' ? code : 1
  console.error(`[dev] app exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
  shutdown(status)
})

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
