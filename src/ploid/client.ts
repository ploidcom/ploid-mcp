import type { AuthContext } from '../auth.js'
import { log } from '../log.js'
import { encodePersonId } from './ids.js'
import { PloidError } from './types.js'
import type {
  CreditsSummary,
  PersonProfile,
  PersonRef,
  PersonSummary,
  PloidClient,
  RevealChannel,
  RevealResult,
  SearchResult,
} from './types.js'
import { MockPloidClient } from './mock.js'

export type { PloidClient } from './types.js'

const DEFAULT_BASE_URL = 'https://api.ploid.com'
const REQUEST_TIMEOUT_MS = 90_000
// Natural-mode search requires page.size >= 25 (docs/openapi.yaml); we fetch
// at least that and slice down to the caller's limit.
const NATURAL_SEARCH_MIN_SIZE = 25

/**
 * Returns the Ploid client for one request. Called per-request so the live
 * client can act on behalf of the authenticated user (credit charges, rate
 * limits). Controlled by PLOID_MODE=mock|live (default mock).
 */
export function createPloidClient(auth: AuthContext): PloidClient {
  if (process.env.PLOID_MODE === 'live') {
    return new HttpPloidClient(process.env.PLOID_API_BASE_URL ?? DEFAULT_BASE_URL, auth)
  }
  return new MockPloidClient()
}

/** Ploid success envelope: { data, meta: { request_id, ... } }. */
interface Envelope<T> {
  data: T
  meta?: { request_id?: string; [key: string]: unknown }
}

/** Ploid `Person` wire schema (docs/openapi.yaml components.schemas.Person). */
interface WirePerson {
  id?: string
  name: string
  headline?: string | null
  job_title?: string | null
  company?: string | null
  location?: string | null
  photo_url?: string | null
  linkedin_url?: string | null
  github_url?: string | null
  x_url?: string | null
  instagram_url?: string | null
  tiktok_url?: string | null
  website_url?: string | null
  match_score?: number | null
  match_reasons?: string[] | null
  summary?: string | null
  profile_url?: string | null
  source?: string
  last_refreshed_at?: string | null
}

function toRef(p: WirePerson): PersonRef {
  return {
    id: p.id,
    name: p.name,
    company: p.company ?? undefined,
    linkedinUrl: p.linkedin_url ?? undefined,
  }
}

function toSummary(p: WirePerson): PersonSummary {
  return {
    person_id: encodePersonId(toRef(p)),
    name: p.name,
    headline: p.headline,
    job_title: p.job_title,
    company: p.company,
    location: p.location,
    match_score: p.match_score,
    match_reasons: p.match_reasons,
    profile_url: p.profile_url,
  }
}

function toProfile(p: WirePerson): PersonProfile {
  const { id: _id, ...rest } = p
  return { ...rest, person_id: encodePersonId(toRef(p)) }
}

/** Client for the real Ploid Public API (docs/openapi.yaml). */
class HttpPloidClient implements PloidClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: AuthContext
  ) {}

  /**
   * Auth: prefer the per-user Ploid API key from the request's auth context
   * (recovered from the OAuth token or sent directly as a bearer key); fall
   * back to a server-level PLOID_API_KEY (dev / single-tenant use).
   */
  private authHeaders(): Record<string, string> {
    const apiKey = this.auth.apiKey || process.env.PLOID_API_KEY
    if (!apiKey) {
      throw new PloidError(
        'unauthorized',
        'No credentials for the Ploid API: request carried no API key and PLOID_API_KEY is not set.'
      )
    }
    return { 'x-api-key': apiKey }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const authHeaders = this.authHeaders()
    const start = Date.now()
    let res: Response
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...authHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      log('ploid_api', { method, path, ok: false, latencyMs: Date.now() - start, error: String(err) })
      throw new PloidError('upstream_error', `Could not reach the Ploid API: ${String(err)}`)
    }

    const payload = (await res.json().catch(() => undefined)) as
      | (Envelope<T> & { error?: { code?: string; message?: string; request_id?: string; [k: string]: unknown } })
      | undefined
    const requestId = payload?.error?.request_id ?? payload?.meta?.request_id
    log('ploid_api', {
      method,
      path,
      status: res.status,
      ok: res.ok,
      latencyMs: Date.now() - start,
      requestId,
    })

    if (!res.ok) {
      throw this.toError(res, payload?.error)
    }
    if (payload === undefined) {
      throw new PloidError('upstream_error', 'Ploid API returned a non-JSON success response.')
    }
    return payload
  }

  private toError(
    res: Response,
    error?: { code?: string; message?: string; request_id?: string; [k: string]: unknown }
  ): PloidError {
    const message = error?.message ?? `Ploid API error (HTTP ${res.status})`
    const extra = {
      requestId: error?.request_id,
      retryAfterSeconds:
        typeof error?.retry_after_seconds === 'number'
          ? error.retry_after_seconds
          : Number(res.headers.get('retry-after')) || undefined,
      availableCredits: typeof error?.available_credits === 'number' ? error.available_credits : undefined,
      requiredCredits: typeof error?.required_credits === 'number' ? error.required_credits : undefined,
    }
    switch (res.status) {
      case 401:
        return new PloidError('unauthorized', message, extra)
      case 402:
        return new PloidError('insufficient_credits', message, extra)
      case 403:
        return new PloidError('insufficient_scope', message, extra)
      case 404:
        return new PloidError('not_found', message, extra)
      case 422:
        return new PloidError('validation_error', message, extra)
      case 429:
        return new PloidError('rate_limited', message, extra)
      default:
        return new PloidError('upstream_error', message, extra)
    }
  }

  async searchPeople(query: string, limit: number): Promise<SearchResult> {
    const { data, meta } = await this.request<WirePerson[]>('POST', '/v1/people/search', {
      mode: 'natural',
      query,
      page: { size: Math.max(NATURAL_SEARCH_MIN_SIZE, limit) },
    })
    return {
      results: data.slice(0, limit).map(toSummary),
      total: typeof meta?.total === 'number' ? meta.total : undefined,
      credits_charged: typeof meta?.credits_charged === 'number' ? meta.credits_charged : undefined,
      remaining_credits: typeof meta?.remaining_credits === 'number' ? meta.remaining_credits : undefined,
      warnings: Array.isArray(meta?.warnings) ? (meta.warnings as string[]) : undefined,
    }
  }

  async getProfile(ref: PersonRef): Promise<PersonProfile> {
    const { data } = await this.request<WirePerson | null>('POST', '/v1/people/lookup', {
      name: ref.name,
      ...(ref.company ? { company: ref.company } : {}),
      ...(ref.linkedinUrl ? { linkedin_url: ref.linkedinUrl } : {}),
      include: ['profile'],
    })
    if (data === null) {
      throw new PloidError('not_found', `Ploid could not resolve "${ref.name}"${ref.company ? ` at ${ref.company}` : ''}.`)
    }
    return toProfile(data)
  }

  async revealContact(ref: PersonRef, channels: RevealChannel[]): Promise<RevealResult> {
    const { data, meta } = await this.request<Record<string, unknown>>('POST', '/v1/people/enrich', {
      ...(ref.id ? { person_id: ref.id } : {}),
      name: ref.name,
      ...(ref.company ? { company: ref.company } : {}),
      ...(ref.linkedinUrl ? { linkedin_url: ref.linkedinUrl } : {}),
      fields: channels,
    })
    return {
      name: ref.name,
      revealed: data,
      credits_charged: typeof meta?.credits_charged === 'number' ? meta.credits_charged : undefined,
      remaining_credits: typeof meta?.remaining_credits === 'number' ? meta.remaining_credits : undefined,
    }
  }

  async getCredits(): Promise<CreditsSummary> {
    const { data } = await this.request<CreditsSummary>('GET', '/v1/account/credits')
    return data
  }
}
