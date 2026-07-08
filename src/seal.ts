import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { log } from './log.js'

/**
 * Sealed tokens: AES-256-GCM-encrypted JSON payloads, base64url-encoded with
 * a type prefix. They are how this server stays stateless — OAuth client
 * registrations, authorization codes, and access/refresh tokens all carry
 * their own data (including the user's Ploid API key) encrypted inside the
 * token instead of living in a database. Any instance holding
 * MCP_TOKEN_SECRET can mint and open them.
 */

let cachedKey: Buffer | null = null

function key(): Buffer {
  if (!cachedKey) {
    const secret = process.env.MCP_TOKEN_SECRET
    if (secret) {
      cachedKey = createHash('sha256').update(secret).digest()
    } else {
      cachedKey = randomBytes(32)
      log('token_secret_generated', {
        warning:
          'MCP_TOKEN_SECRET is not set; using an ephemeral key. Issued tokens will not survive a restart and will not work across instances.',
      })
    }
  }
  return cachedKey
}

export function seal(payload: Record<string, unknown>, prefix: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return prefix + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

/** Returns null on wrong prefix, tampering, malformed input, or expired `exp`. */
export function unseal(token: string, prefix: string): Record<string, unknown> | null {
  if (!token.startsWith(prefix)) return null
  try {
    const raw = Buffer.from(token.slice(prefix.length), 'base64url')
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const ciphertext = raw.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key(), iv)
    decipher.setAuthTag(tag)
    const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    const payload: unknown = JSON.parse(json)
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
    const obj = payload as Record<string, unknown>
    if (typeof obj.exp === 'number' && Date.now() / 1000 > obj.exp) return null
    return obj
  } catch {
    return null
  }
}

export function sha256base64url(input: string): string {
  return createHash('sha256').update(input).digest('base64url')
}
