import { encodePersonId } from './ids.js'
import { PloidError, REVEAL_COST } from './types.js'
import type {
  CreditsSummary,
  PersonProfile,
  PersonRef,
  PloidClient,
  RevealChannel,
  RevealResult,
  SearchResult,
} from './types.js'

/**
 * In-repo mock of the Ploid API so the MCP server is fully usable before the
 * real API is wired in. Mirrors the live client's behavior: same person_id
 * tokens, same result shapes (including credit accounting), same errors.
 * Search is naive keyword matching over a small fixed dataset.
 */

interface MockPerson {
  profile: Omit<PersonProfile, 'person_id'>
  contacts: Partial<Record<RevealChannel, string>>
}

const MOCK_BALANCE = 420

const PEOPLE: Array<{ id: string } & MockPerson> = [
  {
    id: 'per_9f2ka81m',
    profile: {
      name: 'Ana Novak',
      headline: 'VP of Engineering at Brightpath (fintech)',
      job_title: 'VP of Engineering',
      company: 'Brightpath',
      location: 'Ljubljana, Slovenia',
      summary:
        'Engineering leader focused on payments infrastructure. Previously scaled the platform team at Klarna from 8 to 60 engineers. Speaks about engineering leadership, payments, distributed systems, Go, and Kubernetes. MSc in Computer Science, University of Ljubljana.',
      linkedin_url: 'https://www.linkedin.com/in/ana-novak-example',
      github_url: 'https://github.com/ananovak',
      website_url: 'https://ananovak.dev',
      profile_url: 'https://ploid.com/p/per_9f2ka81m',
      source: 'ploid',
      last_refreshed_at: '2026-06-28T10:12:00.000Z',
    },
    contacts: {
      work_email: 'ana.novak@brightpath.example',
      personal_email: 'ana@ananovak.dev',
      mobile_phone: '+386 40 555 021',
    },
  },
  {
    id: 'per_3xq07dwn',
    profile: {
      name: 'Marcus Feld',
      headline: 'Head of Sales, DACH at Northwind Robotics',
      job_title: 'Head of Sales, DACH',
      company: 'Northwind Robotics',
      location: 'Berlin, Germany',
      summary:
        'B2B sales leader in industrial automation. Built Northwind’s DACH pipeline from zero to €12M ARR. Previously Account Executive at SAP. BSc in Business, WHU – Otto Beisheim School of Management.',
      linkedin_url: 'https://www.linkedin.com/in/marcus-feld-example',
      profile_url: 'https://ploid.com/p/per_3xq07dwn',
      source: 'ploid',
      last_refreshed_at: '2026-07-01T08:40:00.000Z',
    },
    contacts: {
      work_email: 'm.feld@northwind-robotics.example',
      mobile_phone: '+49 171 555 0032',
    },
  },
  {
    id: 'per_k28sm4vt',
    profile: {
      name: 'Priya Raghavan',
      headline: 'Staff Machine Learning Engineer at Coastline AI',
      job_title: 'Staff ML Engineer',
      company: 'Coastline AI',
      location: 'San Francisco, CA, USA',
      summary:
        'ML engineer working on retrieval and ranking systems; previously Pinterest. Speaks regularly about evaluation of LLM applications. Skills: machine learning, information retrieval, Python, LLM evaluation, ranking. BTech, IIT Madras.',
      linkedin_url: 'https://www.linkedin.com/in/priya-raghavan-example',
      github_url: 'https://github.com/priyar',
      x_url: 'https://x.com/priyar_ml',
      website_url: 'https://priya.fyi',
      profile_url: 'https://ploid.com/p/per_k28sm4vt',
      source: 'ploid',
      last_refreshed_at: '2026-06-15T19:03:00.000Z',
    },
    contacts: {
      work_email: 'priya@coastline.example',
    },
  },
  {
    id: 'per_77hj1qpc',
    profile: {
      name: 'Tomás Herrera',
      headline: 'Founder & CEO at Verdania (climate tech)',
      job_title: 'Founder & CEO',
      company: 'Verdania',
      location: 'Barcelona, Spain',
      summary:
        'Second-time founder building soil-carbon measurement hardware; raised a €6M seed round in 2025. Previously co-founder & CTO of Riego Labs (acquired). MSc in Industrial Engineering, UPC Barcelona.',
      linkedin_url: 'https://www.linkedin.com/in/tomas-herrera-example',
      website_url: 'https://verdania.example',
      profile_url: 'https://ploid.com/p/per_77hj1qpc',
      source: 'ploid',
      last_refreshed_at: '2026-06-20T14:55:00.000Z',
    },
    contacts: {
      work_email: 'tomas@verdania.example',
      personal_email: 'tomas.herrera@personal.example',
    },
  },
  {
    id: 'per_c51wn0ze',
    profile: {
      name: 'Grace Okonkwo',
      headline: 'Product Design Lead at Mira Health',
      job_title: 'Product Design Lead',
      company: 'Mira Health',
      location: 'London, UK',
      summary:
        'Design lead for consumer health apps; previously design systems at Monzo. Mentors early-career designers. Skills: product design, design systems, healthcare UX, Figma, user research. BA in Design, Goldsmiths.',
      linkedin_url: 'https://www.linkedin.com/in/grace-okonkwo-example',
      website_url: 'https://graceokonkwo.example',
      profile_url: 'https://ploid.com/p/per_c51wn0ze',
      source: 'ploid',
      last_refreshed_at: '2026-05-30T09:20:00.000Z',
    },
    contacts: {},
  },
  {
    id: 'per_m94rt2xb',
    profile: {
      name: 'Daniel Kovač',
      headline: 'Senior Backend Engineer at Ploid',
      job_title: 'Senior Backend Engineer',
      company: 'Ploid',
      location: 'Zagreb, Croatia',
      summary:
        'Backend engineer working on search infrastructure and data pipelines; previously Infobip. TypeScript and Rust; occasional OSS contributor. MSc in Computing, University of Zagreb.',
      linkedin_url: 'https://www.linkedin.com/in/daniel-kovac-example',
      github_url: 'https://github.com/dkovac',
      profile_url: 'https://ploid.com/p/per_m94rt2xb',
      source: 'ploid',
      last_refreshed_at: '2026-07-03T11:47:00.000Z',
    },
    contacts: {
      work_email: 'daniel.kovac@ploid.example',
    },
  },
]

function refFor(p: { id: string } & MockPerson): PersonRef {
  return {
    id: p.id,
    name: p.profile.name,
    company: p.profile.company ?? undefined,
    linkedinUrl: p.profile.linkedin_url ?? undefined,
  }
}

/** Match an incoming ref the way the live API would: id, linkedin, or name. */
function findPerson(ref: PersonRef) {
  return PEOPLE.find(
    (p) =>
      p.id === ref.id ||
      (ref.linkedinUrl && p.profile.linkedin_url === ref.linkedinUrl) ||
      p.profile.name.toLowerCase() === ref.name.toLowerCase()
  )
}

export class MockPloidClient implements PloidClient {
  async searchPeople(query: string, limit: number): Promise<SearchResult> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1)
    const scored = PEOPLE.map((p) => {
      const text = JSON.stringify(p.profile).toLowerCase()
      const matched = terms.filter((t) => text.includes(t))
      return { p, matched }
    })
      .filter(({ matched }) => matched.length > 0)
      .sort((a, b) => b.matched.length - a.matched.length)

    const results = scored.slice(0, limit).map(({ p, matched }) => ({
      person_id: encodePersonId(refFor(p)),
      name: p.profile.name,
      headline: p.profile.headline,
      job_title: p.profile.job_title,
      company: p.profile.company,
      location: p.profile.location,
      match_score: Math.round((matched.length / Math.max(terms.length, 1)) * 100) / 100,
      match_reasons: matched.map((t) => `matched "${t}"`),
      profile_url: p.profile.profile_url,
    }))

    return {
      results,
      total: scored.length,
      credits_charged: Math.ceil(Math.max(results.length, 1) / 10),
      remaining_credits: MOCK_BALANCE,
    }
  }

  async getProfile(ref: PersonRef): Promise<PersonProfile> {
    const person = findPerson(ref)
    if (!person) {
      throw new PloidError('not_found', `Ploid could not resolve "${ref.name}".`)
    }
    return { ...person.profile, person_id: encodePersonId(refFor(person)) }
  }

  async revealContact(ref: PersonRef, channels: RevealChannel[]): Promise<RevealResult> {
    const person = findPerson(ref)
    if (!person) {
      throw new PloidError('not_found', `Ploid could not resolve "${ref.name}".`)
    }
    const revealed: Record<string, unknown> = {}
    let charged = 0
    for (const channel of channels) {
      const value = person.contacts[channel]
      if (value) {
        charged += REVEAL_COST[channel]
        revealed[channel] = {
          status: 'found',
          value,
          evidence: [{ source: 'mock', confidence: 0.95 }],
        }
      } else {
        // Failed fields are never billed (Ploid billing rules).
        revealed[channel] = { status: 'not_found', value: null }
      }
    }
    return {
      name: person.profile.name,
      revealed,
      credits_charged: charged,
      remaining_credits: MOCK_BALANCE - charged,
    }
  }

  async getCredits(): Promise<CreditsSummary> {
    return {
      balance_credits: MOCK_BALANCE,
      balance_usd: MOCK_BALANCE * 0.1,
      plan: 'mock',
      api_key_budget: null,
    }
  }
}
