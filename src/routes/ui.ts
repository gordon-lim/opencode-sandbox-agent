import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const UI_DIR = path.resolve(__dirname, '../ui')
const uiCache = new Map<string, Promise<string>>()

function loadUiFile(fileName: string): Promise<string> {
  let cached = uiCache.get(fileName)
  if (!cached) {
    cached = readFile(path.join(UI_DIR, fileName), 'utf8')
    uiCache.set(fileName, cached)
  }
  return cached
}

export function uiRoutes() {
  const router = new Hono()

  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-cache')
    return c.html(await loadUiFile('index.html'))
  })

  router.get('/app.js', async (c) => {
    return c.newResponse(await loadUiFile('app.js'), 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    })
  })

  router.get('/styles.css', async (c) => {
    return c.newResponse(await loadUiFile('styles.css'), 200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'no-cache',
    })
  })

  return router
}
