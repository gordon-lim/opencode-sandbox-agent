import type { Context, Next } from 'hono'

const AGENT_API_KEY = process.env.AGENT_API_KEY
if (!AGENT_API_KEY) {
  throw new Error('AGENT_API_KEY environment variable is required')
}

const KEY_BYTES = Buffer.from(AGENT_API_KEY, 'utf8')

/**
 * Constant-time comparison of two strings using XOR to prevent timing attacks.
 */
function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')

  if (aBuf.length !== bBuf.length) {
    // Still do a dummy comparison to maintain constant time
    let dummy = 0
    for (let i = 0; i < KEY_BYTES.length; i++) {
      dummy ^= KEY_BYTES[i]!
    }
    return false
  }

  let diff = 0
  for (let i = 0; i < aBuf.length; i++) {
    diff |= aBuf[i]! ^ bBuf[i]!
  }
  return diff === 0
}

export function bearerAuth() {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization')

    if (!authHeader) {
      return c.json({ error: 'Missing Authorization header' }, 401)
    }

    if (!authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Invalid Authorization header format' }, 401)
    }

    const token = authHeader.slice(7)

    if (!safeCompare(token, AGENT_API_KEY!)) {
      return c.json({ error: 'Invalid API key' }, 401)
    }

    await next()
  }
}
