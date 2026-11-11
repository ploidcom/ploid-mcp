// Generated from Ploid's private wire-type package. Types only; do not edit by hand.
/** Wire types for contact enrichment (`POST /v1/enrich` with `fields`). */

/** `linkedin_url` is the reverse lookup: the profile behind an email identifier. */
declare const PUBLIC_ENRICH_FIELDS: readonly ["work_email", "personal_email", "phone", "linkedin_url"];
type PublicEnrichField = (typeof PUBLIC_ENRICH_FIELDS)[number];
interface PublicEnrichContact {
    value: string | null;
    status: "found" | "not_found" | "unavailable";
    confidence: "guess" | "strong" | "verified" | null;
    source: "contact_network" | "linked_profile" | "public_code" | "public_web" | null;
    last_seen: string | null;
    /**
     * work_email only: the employer the address belongs to, which may not be the requested company.
     * `domain` is the address's domain; `name` is set only when the person's current employer owns that domain.
     */
    employer?: {
        name: string | null;
        domain: string;
    } | null;
}
/** Only the requested fields are present. */
type PublicEnrichResult = Partial<Record<PublicEnrichField, PublicEnrichContact>>;

declare const PERSON_RESEARCH_INTEREST_KINDS: readonly ["hobby", "sport", "team", "cause", "food_drink", "books_media", "travel", "brand", "other"];
type PersonResearchInterestKind = (typeof PERSON_RESEARCH_INTEREST_KINDS)[number];

/** Bounded identity previews from the owned people index; 1 ACU per completed search. */
interface PublicPeopleCandidate {
    person_id: string;
    name: string;
    title: string | null;
    company: string | null;
    location: string | null;
    linkedin_url: string | null;
    /** A non-LinkedIn public profile (personal site, GitHub) indexed for the person; null when LinkedIn is the only one. */
    profile_url: string | null;
    /** Always false: an index match is a lead, not a verified identity. Identity is verified by POST /v1/person. */
    identity_verified: false;
}
interface PublicPeopleCandidatesResult {
    source: "ploid_people_index";
    matches: PublicPeopleCandidate[];
    returned: number;
    limit: number;
    usage: {
        acu_used: number;
    };
}
/** Pure wire types for the focused public people API. */
type PublicEvidenceStatus = "found" | "not_found" | "not_verified" | "unavailable";
interface PublicFieldProvenance {
    source: string;
    source_url: string;
    first_seen: string | null;
    last_seen: string;
    confidence: number;
}
type PublicProvenance = Record<string, PublicFieldProvenance[]>;
interface PublicApiUsage {
    acu_used: number;
    acu_remaining?: number;
    acu_value_usd?: number;
    billed: string[];
    free: string[];
    not_found: string[];
}
type PublicPersonIdentifier = {
    person_id: string;
} | {
    linkedin_url: string;
} | {
    name: string;
    company_domain: string;
};
/** How much research `/v1/person` runs. `deep` is the default. */
declare const PUBLIC_PERSON_RESEARCH_TYPES: readonly ["standard", "deep"];
type PublicPersonResearchType = (typeof PUBLIC_PERSON_RESEARCH_TYPES)[number];
interface PublicPersonSourceLink {
    title: string;
    url: string;
    categories: string[];
    status: "found" | "not_verified";
    confidence: number;
}
interface PublicPersonIdentity {
    name: string;
    linkedin_url: string | null;
    headline: string | null;
    company: string | null;
    location: string | null;
    confidence: number;
}
interface PublicPersonProfessionalSection {
    current: {
        headline: string | null;
        company: string | null;
        location: string | null;
    };
    history: Array<{
        title: string | null;
        company: string | null;
        period: string | null;
        location: string | null;
        confidence: number;
        /** True for the role the reviewed evidence establishes as current; it also fills `current`. */
        current?: boolean;
        timeframe?: "historical" | "undated" | "dated";
        evidence_statement?: string;
    }>;
    education: Array<{
        school: string | null;
        degree: string | null;
        field_of_study: string | null;
        period: string | null;
        confidence: number;
        timeframe?: "historical" | "undated" | "dated";
        evidence_statement?: string;
    }>;
    skills: string[] | null;
}
interface PublicPersonPresenceSection {
    platforms: Array<{
        timeframe?: "historical" | "undated" | "dated";
        evidence_statement?: string;
        source_urls?: string[];
        platform: string;
        handle: string | null;
        url: string;
        display_name: string | null;
        bio: string | null;
        avatar_url: string | null;
        followers: number | null;
        following: number | null;
        content_count: number | null;
        total_likes: number | null;
        verified: boolean | null;
        private: boolean | null;
        last_active: string | null;
        topics: string[];
        recent_activity: Array<{
            kind: "post" | "share" | "article" | "video" | "repository" | "unknown";
            url: string;
            text: string | null;
            published_at: string | null;
            media_urls: string[];
            likes: number | null;
            stars: number | null;
            comments: number | null;
            shares: number | null;
            views: number | null;
        }>;
        confidence: number;
    }>;
}
interface PublicPersonSignalsSection {
    interests: Array<{
        timeframe?: "historical" | "undated" | "dated";
        evidence_statement?: string;
        source_urls?: string[];
        interest: string;
        strength: number;
        evidence_count: number;
        status: "found" | "not_verified";
        source_url: string | null;
    }>;
    activity_cadence: null;
    /** Reserved and deprecated; evidence-backed personal interests are in `personal_interests`. */
    affinities: [];
    personal_interests: Array<{
        category: PersonResearchInterestKind;
        interest: string;
        evidence_quote: string | null;
        source_url: string;
        source_urls: string[];
        timeframe: "historical" | "undated" | "dated";
    }>;
    coverage: Record<string, {
        status: PublicEvidenceStatus;
        evidenceCount: number;
    }>;
}
/** One reviewed claim from research: a publication, patent, open-source project or media appearance. */
interface PublicPersonFinding {
    title: string | null;
    /** Publisher, venue, patent office, project owner or show, when the evidence names it. */
    organization: string | null;
    period: string | null;
    url: string;
    statement: string;
    evidence_quote: string | null;
    source_urls: string[];
    timeframe: "historical" | "undated" | "dated";
}
interface PublicPersonRecord {
    person_id: string;
    summary: string;
    age_range: {
        min: number;
        max: number;
    } | null;
    identity: PublicPersonIdentity;
    source_links: PublicPersonSourceLink[];
    professional: PublicPersonProfessionalSection;
    presence: PublicPersonPresenceSection;
    signals: PublicPersonSignalsSection;
    /** Absent only on run results stored before these sections existed. */
    research?: {
        publications: PublicPersonFinding[];
        patents: PublicPersonFinding[];
    };
    work?: {
        open_source: PublicPersonFinding[];
    };
    media?: {
        appearances: PublicPersonFinding[];
    };
    provenance: PublicProvenance;
    contact?: PublicEnrichResult;
}
/** A completed research attempt whose evidence cannot establish one person's identity. */
interface PublicPersonUncertainty {
    resolution: "unsure";
    reason: "ambiguous_identity" | "insufficient_evidence";
    message: string;
    /** Plain, Markdown-escaped limitations from the reviewed research outcome. */
    limitations: string[];
    suggested_clues: Array<"linkedin_url" | "personal_website">;
}
interface PublicPersonResearchMeta {
    status: "completed" | "partial";
    missing_sections: string[];
}
interface PublicPersonResponse {
    data: PublicPersonRecord | null;
    meta: {
        request_id: string;
        found: boolean;
        stale?: boolean;
        /** End of the organization's paid 90-day free-reread window. */
        access_expires_at?: string;
        usage: PublicApiUsage;
        warnings?: string[];
        /** Reviewed research status; `partial` names the sections no accepted evidence covered. */
        research?: PublicPersonResearchMeta;
    } & Partial<PublicPersonUncertainty>;
}
interface PublicPersonRunResponse {
    data: {
        run_id: string;
        status: "queued" | "running" | "cancelled";
        poll_url?: string;
    };
    meta: {
        request_id: string;
        usage: PublicApiUsage;
    };
}

type SetStatus = "idle" | "running" | "paused";
type SetSearchStatus = "created" | "running" | "completed" | "canceled" | "failed";
type SetItemStatus = "admitted" | "review";
type SetSearchBehavior = "override" | "append";
type SetEntityType = "person" | "company" | "custom";

/** Wire types for the public Sets API (`/v1/sets`). */

interface PublicSetsSearchPricing {
    search_credits_per_10_admitted: number;
    estimated_search_credits: number;
    usd_per_credit: number;
    estimated_usd_per_admitted_person: number;
    estimated_search_usd: number;
    note: string;
}
interface PublicSetEnrichment {
    id: string;
    title: string | null;
    description: string;
    format: string;
    status: string;
}
interface PublicSetSearch {
    id: string;
    query: string;
    count: number;
    status: SetSearchStatus;
    criteria: unknown;
    behavior: SetSearchBehavior;
    created_at: string;
    finished_at: string | null;
    /**
     * Why a completed search holds fewer people than `count`: the Set's credit or
     * token budget, a candidate pool that ran dry, or the search's time budget.
     * Null when the count was reached or the search failed.
     */
    stop_reason: "budget" | "exhausted" | "time_budget" | null;
    /**
     * Only on `GET /v1/sets/:id`, while the search is `created` and waiting for a worker: its
     * 1-based place in the queue and a rough wait in seconds. Null once it starts.
     */
    queue: {
        position: number;
        estimated_wait_seconds: number;
    } | null;
}
/** `POST /v1/sets` */
interface PublicSetCreated {
    id: string;
    title: string;
    entity_type: "person";
    status: "running";
    search: {
        id: string;
        status: "created";
        count: number;
        query: string;
        criteria: string[];
    };
    pricing: PublicSetsSearchPricing;
    enrichments: PublicSetEnrichment[];
    events_url: string;
    items_url: string;
}
/** `GET /v1/sets/:id`; searches are newest first. */
interface PublicSetDetail {
    id: string;
    title: string;
    entity_type: SetEntityType;
    status: SetStatus;
    item_count: number;
    admitted_count: number;
    workspace_list_id: string | null;
    created_at: string;
    pricing: PublicSetsSearchPricing & {
        credits_used: number;
        usd_used: number;
        usd_per_admitted_person: number;
    };
    costs: Record<string, unknown>;
    searches: PublicSetSearch[];
    enrichments: PublicSetEnrichment[];
    monitors: Array<{
        id: string;
        status: string;
        next_run_at: string | null;
    }>;
    imports: Array<{
        id: string;
        status: string;
        row_count: number;
        created_at: string;
    }>;
}
interface PublicSetItem {
    id: string;
    status: SetItemStatus;
    name: string | null;
    title: string | null;
    company: string | null;
    location: string | null;
    linkedin_url: string | null;
    properties: Record<string, unknown>;
    verification: unknown;
    enrichments: unknown;
    created_at: string;
}
/** `GET /v1/sets/:id/items` */
interface PublicSetItemsPage {
    items: PublicSetItem[];
    next_cursor: string | null;
}
/** `POST /v1/sets/:id/cancel`; `searches` lists the search IDs it stopped. */
interface PublicSetCancelResult {
    id: string;
    canceling: true;
    searches: string[];
}

/** Wire types for the device authorization flow (`/api/auth/device/start` and `/token`) used by `ploid login` and `ploid-mcp login`. */
interface DeviceAuthStartRequest {
    /** Shown on the browser approval page and in the minted key's name. */
    client_name?: string;
    /** Omit for the default CLI scopes, which the CLI and local MCP server share. */
    scopes?: string[];
}
interface DeviceAuthStartResponse {
    /** Secret returned once; the client polls `/token` with it. */
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    /** Suggested polling cadence, in seconds. */
    interval: number;
}
interface DeviceAuthApproved {
    status: "approved";
    api_key: string;
    key_prefix: string;
    scopes: string[];
    organization_id: string;
    expires_at: string;
}
type DeviceAuthTokenResponse = {
    status: "pending" | "slow_down";
    interval: number;
} | {
    status: "denied";
} | {
    status: "expired";
} | DeviceAuthApproved;

export type { DeviceAuthApproved, DeviceAuthStartRequest, DeviceAuthStartResponse, DeviceAuthTokenResponse, PublicEnrichContact, PublicEnrichField, PublicPeopleCandidatesResult, PublicPersonIdentifier, PublicPersonRecord, PublicPersonResearchType, PublicPersonResponse, PublicPersonRunResponse, PublicSetCancelResult, PublicSetCreated, PublicSetDetail, PublicSetItem, PublicSetItemsPage, PublicSetSearch, SetSearchStatus };
