/**
 * Types for the Ploid people-data API (docs/openapi.yaml).
 *
 * Field names mirror Ploid's wire format (snake_case Person schema) so tool
 * output matches Ploid's own docs. The one deliberate difference: Ploid's raw
 * `id` is never exposed. Tools deal in `person_id` — a self-contained token
 * (see ids.ts) that also carries name/company/linkedin_url, because Ploid has
 * no profile-by-id endpoint; lookup and enrich identify people by those fields.
 */

/** What we need to re-identify one person against the Ploid API. */
export interface PersonRef {
  id?: string
  name: string
  company?: string
  linkedinUrl?: string
}

/** Compact search hit. `person_id` is the token from ids.ts. */
export interface PersonSummary {
  person_id: string
  name: string
  headline?: string | null
  job_title?: string | null
  company?: string | null
  location?: string | null
  match_score?: number | null
  match_reasons?: string[] | null
  profile_url?: string | null
}

/** Full normalized profile (Ploid `Person`), still without contact details. */
export interface PersonProfile extends PersonSummary {
  summary?: string | null
  photo_url?: string | null
  linkedin_url?: string | null
  github_url?: string | null
  x_url?: string | null
  instagram_url?: string | null
  tiktok_url?: string | null
  website_url?: string | null
  source?: string
  last_refreshed_at?: string | null
}

export interface SearchResult {
  results: PersonSummary[]
  total?: number
  /** Search is billed ~1 credit per 10 matched results. */
  credits_charged?: number
  remaining_credits?: number
  warnings?: string[]
}

/** Contact channels that can be revealed, with their credit prices. */
export const REVEAL_CHANNELS = ['work_email', 'personal_email', 'mobile_phone'] as const
export type RevealChannel = (typeof REVEAL_CHANNELS)[number]
export const REVEAL_COST: Record<RevealChannel, number> = {
  work_email: 1,
  personal_email: 3,
  mobile_phone: 10,
}

export interface RevealResult {
  name: string
  /** Enrichment payload keyed by field, passed through from Ploid (includes per-field evidence). */
  revealed: Record<string, unknown>
  credits_charged?: number
  remaining_credits?: number
}

/** Account credit summary (GET /v1/account/credits), passed through from Ploid. */
export type CreditsSummary = Record<string, unknown>

/** Machine-readable error codes, aligned with Ploid's API error codes. */
export type PloidErrorCode =
  | 'not_found'
  | 'insufficient_credits'
  | 'insufficient_scope'
  | 'rate_limited'
  | 'unauthorized'
  | 'validation_error'
  | 'invalid_request'
  | 'upstream_error'

/** The only error type the Ploid client is allowed to throw. */
export class PloidError extends Error {
  constructor(
    readonly code: PloidErrorCode,
    message: string,
    readonly extra: {
      /** Seconds to wait before retrying, for rate_limited. */
      retryAfterSeconds?: number
      /** Ploid request ID, for support escalation. */
      requestId?: string
      availableCredits?: number
      requiredCredits?: number
    } = {}
  ) {
    super(message)
    this.name = 'PloidError'
  }
}

/**
 * Everything the MCP tools need from Ploid. Implementations: mock (dev)
 * and HTTP (real API). Swapping implementations must not touch the tools.
 */
export interface PloidClient {
  searchPeople(query: string, limit: number): Promise<SearchResult>
  getProfile(ref: PersonRef): Promise<PersonProfile>
  /** Consumes credits per revealed channel (see REVEAL_COST). */
  revealContact(ref: PersonRef, channels: RevealChannel[]): Promise<RevealResult>
  getCredits(): Promise<CreditsSummary>
}
