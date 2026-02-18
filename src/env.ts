import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT_DIR = path.resolve(__dirname, '..')

function loadIfExists(fileName: string) {
  const filePath = path.join(ROOT_DIR, fileName)

  try {
    process.loadEnvFile(filePath)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : ''
    if (code === 'ENOENT') {
      return
    }
    throw error
  }
}

// Priority order (first value wins because process.loadEnvFile does not override existing env vars):
// 1) .env.local
// 2) .env.opencode.local
// 3) .env.opencode
// 4) .env
// 5) .env.example
// 6) .env.opencode.example
loadIfExists('.env.local')
loadIfExists('.env.opencode.local')
loadIfExists('.env.opencode')
loadIfExists('.env')
loadIfExists('.env.example')
loadIfExists('.env.opencode.example')
