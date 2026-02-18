import { Hono } from 'hono'
import { mkdirSync, promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { WORKSPACE_ROOT } from '../workspace/config'

const MAX_TREE_ENTRIES = Number(process.env.WORKSPACE_MAX_TREE_ENTRIES ?? 2000)
const MAX_TREE_DEPTH = Number(process.env.WORKSPACE_MAX_TREE_DEPTH ?? 8)
const MAX_FILE_BYTES = Number(process.env.WORKSPACE_MAX_FILE_BYTES ?? 1_000_000)
const IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store'])

mkdirSync(WORKSPACE_ROOT, { recursive: true })

interface WorkspaceNode {
  type: 'directory' | 'file'
  name: string
  path: string
  children?: WorkspaceNode[]
}

interface TreeState {
  count: number
  truncated: boolean
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function resolveInWorkspace(requestedPath: string | undefined) {
  const candidate = requestedPath?.trim() || '.'
  const absolute = path.resolve(WORKSPACE_ROOT, candidate)
  const rootWithSep = WORKSPACE_ROOT.endsWith(path.sep)
    ? WORKSPACE_ROOT
    : `${WORKSPACE_ROOT}${path.sep}`

  if (absolute !== WORKSPACE_ROOT && !absolute.startsWith(rootWithSep)) {
    return null
  }

  const relativePath = path.relative(WORKSPACE_ROOT, absolute)
  return {
    absolute,
    relative: relativePath === '' ? '.' : toPosix(relativePath),
  }
}

function sortDirents(a: Dirent, b: Dirent): number {
  if (a.isDirectory() && !b.isDirectory()) return -1
  if (!a.isDirectory() && b.isDirectory()) return 1
  return a.name.localeCompare(b.name)
}

async function buildTree(
  absoluteDir: string,
  relativeDir: string,
  depth: number,
  state: TreeState,
): Promise<WorkspaceNode[]> {
  if (state.count >= MAX_TREE_ENTRIES) {
    state.truncated = true
    return []
  }

  let entries: Dirent[]
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true })
  } catch {
    return []
  }

  const sorted = entries.sort(sortDirents)
  const nodes: WorkspaceNode[] = []

  for (const entry of sorted) {
    if (IGNORED_NAMES.has(entry.name) || entry.isSymbolicLink()) {
      continue
    }

    if (state.count >= MAX_TREE_ENTRIES) {
      state.truncated = true
      break
    }

    state.count += 1
    const entryPath = relativeDir === '.' ? entry.name : `${relativeDir}/${entry.name}`

    if (entry.isDirectory()) {
      const node: WorkspaceNode = {
        type: 'directory',
        name: entry.name,
        path: entryPath,
      }

      if (depth < MAX_TREE_DEPTH) {
        node.children = await buildTree(path.join(absoluteDir, entry.name), entryPath, depth + 1, state)
      } else {
        state.truncated = true
      }

      nodes.push(node)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    nodes.push({
      type: 'file',
      name: entry.name,
      path: entryPath,
    })
  }

  return nodes
}

export function workspaceRoutes() {
  const router = new Hono()

  router.get('/workspace/tree', async (c) => {
    const target = resolveInWorkspace(c.req.query('path'))
    if (!target) {
      return c.json({ error: 'Requested path is outside workspace root' }, 400)
    }

    let targetStats
    try {
      targetStats = await fs.stat(target.absolute)
    } catch {
      return c.json({ error: 'Path not found' }, 404)
    }

    if (!targetStats.isDirectory()) {
      return c.json({ error: 'Path must be a directory' }, 400)
    }

    const state: TreeState = { count: 0, truncated: false }
    const nodes = await buildTree(target.absolute, target.relative, 0, state)

    return c.json({
      root: WORKSPACE_ROOT,
      basePath: target.relative,
      nodes,
      truncated: state.truncated,
      maxEntries: MAX_TREE_ENTRIES,
      maxDepth: MAX_TREE_DEPTH,
    })
  })

  router.get('/workspace/file', async (c) => {
    const requestedPath = c.req.query('path')
    if (!requestedPath) {
      return c.json({ error: 'path query parameter is required' }, 400)
    }

    const target = resolveInWorkspace(requestedPath)
    if (!target) {
      return c.json({ error: 'Requested path is outside workspace root' }, 400)
    }

    let targetStats
    try {
      targetStats = await fs.stat(target.absolute)
    } catch {
      return c.json({ error: 'File not found' }, 404)
    }

    if (!targetStats.isFile()) {
      return c.json({ error: 'Requested path is not a file' }, 400)
    }

    if (targetStats.size > MAX_FILE_BYTES) {
      return c.json(
        { error: `File is too large (${targetStats.size} bytes). Max allowed is ${MAX_FILE_BYTES} bytes.` },
        413,
      )
    }

    const buffer = await fs.readFile(target.absolute)
    if (buffer.includes(0)) {
      return c.json({ error: 'Binary files are not supported in preview' }, 415)
    }

    return c.json({
      path: target.relative,
      size: targetStats.size,
      modifiedAt: targetStats.mtime.toISOString(),
      content: buffer.toString('utf8'),
    })
  })

  return router
}
