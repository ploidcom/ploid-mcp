import type { PublicPeopleCandidatesResult, PublicPersonIdentifier, PublicPersonResearchType } from "./contracts.js";
import { z } from "zod";
import { boundedArray, boundedInt, boundedString, rangeNote } from "./bounds.js";

/** research_person accepts only an already-selected person, never a name to resolve. */
type SelectedPerson = Extract<PublicPersonIdentifier, { person_id: string } | { linkedin_url: string }>;

/** Kept literal: published MCP code may import only types from ./contracts.js. */
const RESEARCH_TYPES = ["standard", "deep"] as const satisfies readonly PublicPersonResearchType[];

const httpsUrl = boundedString(1, 2_000).url().startsWith("https://");

const selectionGuidance =
    "research_person accepts exactly one of person_id or linkedin_url, never both and never neither: a selected person_id from search_people, or an HTTPS LinkedIn person profile URL. For a name, call search_people and ask the user to choose. Legacy name, company, company_domain, depth and max_acu arguments are not supported; type, goal, website_url and anchors are optional next to the identifier.";

const personIdentifierFields = {
    person_id: boundedString(1, 500)
        .regex(/^[A-Za-z0-9_-]+$/)
        .describe("A person_id returned by search_people, up to 500 characters. Provide this or linkedin_url, not both.")
        .optional(),
    linkedin_url: boundedString(1, 2_048)
        .url()
        .refine((value) => {
            if (!URL.canParse(value)) return false;
            const url = new URL(value);
            return (
                url.protocol === "https:" &&
                !url.username &&
                !url.password &&
                !url.port &&
                /^(?:[a-z]{2,3}\.|www\.)?linkedin\.com$/i.test(url.hostname) &&
                /^\/in\/[^/]+\/?$/.test(url.pathname)
            );
        }, "Provide an HTTPS LinkedIn person profile URL, for example https://www.linkedin.com/in/name.")
        .describe("An HTTPS LinkedIn person profile URL such as https://www.linkedin.com/in/name, up to 2048 characters. Provide this or person_id, not both.")
        .optional(),
};

/** Exactly one identifier, nothing else: the input of get_email and get_phone. */
export const contactPersonInputSchema = z
    .strictObject(personIdentifierFields, {
        error: "Pass exactly one of person_id (from search_people) or linkedin_url (an HTTPS LinkedIn person profile URL), never both and never neither. For a name, call search_people and ask the user to choose.",
    })
    .refine((value) => Boolean(value.person_id) !== Boolean(value.linkedin_url), "Pass exactly one of person_id or linkedin_url.")
    .meta({ anyOf: [{ required: ["person_id"] }, { required: ["linkedin_url"] }] });

export const researchPersonInputSchema = z
    .strictObject(
        {
            ...personIdentifierFields,
            type: z.enum(RESEARCH_TYPES).describe("standard (10 ACU) or deep (25 ACU, the default).").optional(),
            goal: boundedString(1, 2_000).describe("What to look for, up to 2000 characters.").optional(),
            website_url: httpsUrl.describe("The person's own website, an HTTPS URL up to 2000 characters.").optional(),
            anchors: boundedArray(httpsUrl, 10)
                .min(1)
                .describe("1 to 10 public HTTPS URLs you know belong to this person, such as an X profile or a podcast episode.")
                .optional(),
        },
        { error: selectionGuidance },
    )
    .refine((value) => Boolean(value.person_id) !== Boolean(value.linkedin_url), selectionGuidance)
    .meta({ anyOf: [{ required: ["person_id"] }, { required: ["linkedin_url"] }] }) satisfies z.ZodType<
    Partial<Extract<SelectedPerson, { person_id: string }> & Extract<SelectedPerson, { linkedin_url: string }>>
>;

/** Optional research inputs, passed through only when set. */
export function researchInputs(input: z.infer<typeof researchPersonInputSchema>) {
    return {
        ...(input.type ? { type: input.type } : {}),
        ...(input.goal ? { goal: input.goal } : {}),
        ...(input.website_url ? { website_url: input.website_url } : {}),
        ...(input.anchors ? { anchors: [...new Set(input.anchors)] } : {}),
    };
}

/** The `/v1/person` identifier for validated research_person input, which holds exactly one field. */
export function selectedPerson(input: z.infer<typeof contactPersonInputSchema>): SelectedPerson {
    return input.person_id ? { person_id: input.person_id } : { linkedin_url: input.linkedin_url! };
}

const SEARCH_PEOPLE_LIMIT = { min: 1, max: 10, default: 5 } as const;

export const searchPeopleInputSchema = z.strictObject({
    name: boundedString(2, 200).describe("The person's name, 2 to 200 characters."),
    company: boundedString(1, 200).describe("Current or past company, up to 200 characters.").optional(),
    location: boundedString(1, 200).describe("City, region or country, up to 200 characters.").optional(),
    title: boundedString(1, 200).describe("Job title, up to 200 characters.").optional(),
    limit: boundedInt(SEARCH_PEOPLE_LIMIT.min, SEARCH_PEOPLE_LIMIT.max)
        .default(SEARCH_PEOPLE_LIMIT.default)
        .describe(`Maximum matches to return. ${rangeNote(SEARCH_PEOPLE_LIMIT.min, SEARCH_PEOPLE_LIMIT.max, SEARCH_PEOPLE_LIMIT.default)}`),
});

const searchResultSchema = z.object({
    source: z.literal("ploid_people_index"),
    matches: z
        .array(
            z.object({
                person_id: z.string().min(1),
                name: z.string(),
                title: z.string().nullable(),
                company: z.string().nullable(),
                location: z.string().nullable(),
                linkedin_url: z.string().nullable(),
                profile_url: z
                    .string()
                    .nullable()
                    .describe("A non-LinkedIn public profile when the index holds one; null when linkedin_url is the only profile."),
                identity_verified: z.literal(false).describe("Always false for index matches; identity is verified by research_person."),
            }),
        )
        .max(10),
    returned: z.number().int().min(0).max(10),
    limit: z.number().int().min(1).max(10),
}) satisfies z.ZodType<Omit<PublicPeopleCandidatesResult, "usage">>;

export function searchPeopleResult(payload: { data: unknown; meta: Record<string, unknown> }) {
    const parsed = searchResultSchema.safeParse(payload.data);
    if (!parsed.success || parsed.data.returned !== parsed.data.matches.length || parsed.data.returned > parsed.data.limit) {
        throw new Error("Ploid returned an invalid people-index result.");
    }
    const guidance = parsed.data.matches.length
        ? "Show these matching indexed profiles and ask the user to choose, even if there is only one. Do not automatically choose the highest-ranked match. Deep research of a selected profile costs 25 ACU unless the workspace has active access. Indexed details are not verified or necessarily current; identity_verified is always false here and profile_url is only set for a non-LinkedIn profile."
        : "No matching indexed profiles were returned. Ask for a company, location, title, or explicit LinkedIn profile. This does not establish that the person does not exist.";
    const result = { ...parsed.data, usage: payload.meta.usage, guidance };
    return {
        content: [{ type: "text" as const, text: `${guidance}\n\n${JSON.stringify(result, null, 2)}` }],
        structuredContent: result,
    };
}
