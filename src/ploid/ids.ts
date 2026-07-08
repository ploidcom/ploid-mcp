import type { PersonRef } from './types.js'

/**
 * Person IDs handed to MCP clients are self-contained tokens.
 *
 * Ploid has no profile-by-id endpoint: lookup and enrich identify a person by
 * name/company/linkedin_url. This server is stateless, so everything needed to
 * re-identify a person must live in the ID itself — the token encodes
 * [id, name, company, linkedin_url] as base64url JSON with a `pld_` prefix.
 * Tokens are stable for a given person snapshot and safe to store or share.
 */

const PREFIX = 'pld_'

export function encodePersonId(ref: PersonRef): string {
  const packed = [ref.id ?? null, ref.name, ref.company ?? null, ref.linkedinUrl ?? null]
  return PREFIX + Buffer.from(JSON.stringify(packed)).toString('base64url')
}

/** Returns null for anything that isn't a token we minted. */
export function decodePersonId(token: string): PersonRef | null {
  if (!token.startsWith(PREFIX)) return null
  try {
    const packed: unknown = JSON.parse(Buffer.from(token.slice(PREFIX.length), 'base64url').toString('utf8'))
    if (!Array.isArray(packed) || typeof packed[1] !== 'string' || packed[1].length === 0) return null
    return {
      id: typeof packed[0] === 'string' ? packed[0] : undefined,
      name: packed[1],
      company: typeof packed[2] === 'string' ? packed[2] : undefined,
      linkedinUrl: typeof packed[3] === 'string' ? packed[3] : undefined,
    }
  } catch {
    return null
  }
}
