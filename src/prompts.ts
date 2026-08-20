export function researchPersonPrompt(input: { name: string; company?: string; linkedinUrl?: string; goal?: string }): string {
  return [
    `Research ${input.name}${input.company ? ` at ${input.company}` : ""}.`,
    input.linkedinUrl ? `Known LinkedIn URL: ${input.linkedinUrl}.` : "",
    input.goal ? `Research goal: ${input.goal}.` : "",
    "Return confirmed identity, current role, evidence-backed professional context, three non-creepy personalization angles, and source URLs. Separate confirmed facts from inference.",
  ].filter(Boolean).join(" ");
}

export function findPeoplePrompt(input: { query: string; count: number }): string {
  return `Find up to ${input.count} people matching: ${input.query}. Return name, current role, company, LinkedIn URL when known, why each person matches, confidence, and source URLs.`;
}

export function decisionMakersPrompt(input: { company: string; product: string; count: number; titles?: string[] }): string {
  return `Find up to ${input.count} likely decision-makers at ${input.company} for selling ${input.product}.${input.titles?.length ? ` Prioritize these roles: ${input.titles.join(", ")}.` : ""} Explain the buying role of each person, give confidence, and include source URLs. Do not invent identities.`;
}

export function personalizePrompt(input: { person: string; company?: string; offering: string; channel: string; tone: string }): string {
  return `Research ${input.person}${input.company ? ` at ${input.company}` : ""}, then draft a ${input.channel} message offering ${input.offering}. Tone: ${input.tone}. Ground every personalized detail in verified evidence, avoid creepy observations, include the sources separately, and distinguish inference from fact.`;
}

export function researchCompanyPrompt(input: { company: string; domain?: string; goal?: string }): string {
  return `Research ${input.company}${input.domain ? ` (${input.domain})` : ""}.${input.goal ? ` Goal: ${input.goal}.` : ""} Return current positioning, relevant products, likely buyers, recent evidence-backed signals, decision-maker hypotheses, and source URLs.`;
}
