import path from 'node:path'

export const DEFAULT_WORKSPACE_ROOT = path.resolve(process.cwd(), 'sandbox_workspace')
export const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT)
