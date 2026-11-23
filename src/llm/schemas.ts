import { ORG_FACT_KINDS, ORG_NOISE_FLAGS, SENIORITIES, SUBFUNCTIONS } from '../accounts/types';

export const RANK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'score', 'reason'],
        properties: {
          id: { type: 'string' },
          score: { type: 'integer', minimum: 0, maximum: 100 },
          reason: { type: 'string' },
        },
      },
    },
  },
};

const STRING_ARRAY = { type: 'array', items: { type: 'string' } };

export const RESEARCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'identityConfirmed', 'summary', 'currentRole', 'location', 'signals', 'fitAssessment',
    'recommendedApproach', 'talkingPoints', 'redFlags', 'sources', 'confidence', 'researchScore',
  ],
  properties: {
    identityConfirmed: { type: 'boolean' },
    summary: { type: 'string' },
    currentRole: { type: 'string' },
    location: { type: 'string' },
    signals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['signal', 'finding', 'strength'],
        properties: {
          signal: { type: 'string' },
          finding: { type: 'string' },
          strength: { type: 'string', enum: ['none', 'weak', 'moderate', 'strong'] },
        },
      },
    },
    fitAssessment: { type: 'string' },
    recommendedApproach: { type: 'string' },
    talkingPoints: STRING_ARRAY,
    redFlags: STRING_ARRAY,
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url'],
        properties: { title: { type: 'string' }, url: { type: 'string' } },
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    researchScore: { type: 'integer', minimum: 0, maximum: 100 },
  },
};

export const SENIORITY_VALUES = [
  'founder/owner', 'c-suite', 'partner', 'vp', 'director', 'head of', 'manager',
  'senior ic', 'ic', 'advisor/board', 'student', 'unknown',
] as const;

export const FUNCTION_VALUES = [
  'investing', 'general management', 'sales', 'marketing', 'engineering', 'product', 'design',
  'data/ai', 'operations', 'finance', 'people/recruiting', 'legal', 'consulting',
  'customer success', 'media/creative', 'education/research', 'healthcare', 'public sector', 'other',
] as const;

/** Tag list mirrors PERSONA_TAGS in types.ts (kept literal here so the schema module has no runtime import cycle). */
export const TAG_VALUES = [
  'investor', 'angel', 'vc', 'founder', 'exited founder', 'executive', 'operator', 'advisor',
  'board member', 'recruiter', 'consultant', 'academic', 'creator', 'public sector', 'open to work',
] as const;

export const ENRICH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'company', 'role', 'seniority', 'function', 'industry', 'tags', 'region'],
        properties: {
          id: { type: 'string' },
          company: { type: 'string' },
          role: { type: 'string' },
          seniority: { type: 'string', enum: [...SENIORITY_VALUES] },
          function: { type: 'string', enum: [...FUNCTION_VALUES] },
          industry: { type: 'string' },
          tags: { type: 'array', items: { type: 'string', enum: [...TAG_VALUES] } },
          region: { type: 'string' },
        },
      },
    },
  },
};

// ---------- v6: goal-free dossier ----------
export const DOSSIER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'rateLimited', 'searchesRun', 'identityConfirmed', 'confidence', 'oneLiner', 'currentRole', 'currentCompany', 'location',
    'career', 'education', 'investingSummary', 'investments', 'boards', 'expertise', 'notable', 'publicPresence',
    'recentActivity', 'recentThemes', 'sources',
  ],
  properties: {
    rateLimited: { type: 'boolean', description: 'true if any web search failed, was refused or was rate-limited' },
    searchesRun: { type: 'integer', minimum: 0 },
    identityConfirmed: { type: 'boolean' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    oneLiner: { type: 'string' },
    currentRole: { type: 'string' },
    currentCompany: { type: 'string' },
    location: { type: 'string' },
    career: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'company', 'period', 'current'],
        properties: {
          role: { type: 'string' },
          company: { type: 'string' },
          period: { type: 'string' },
          current: { type: 'boolean' },
        },
      },
    },
    education: STRING_ARRAY,
    investingSummary: { type: 'string' },
    investments: STRING_ARRAY,
    boards: STRING_ARRAY,
    expertise: STRING_ARRAY,
    notable: STRING_ARRAY,
    publicPresence: STRING_ARRAY,
    recentActivity: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'kind', 'title', 'summary', 'url'],
        properties: {
          date: { type: 'string', description: 'YYYY-MM or YYYY-MM-DD; "" if unknown' },
          kind: { type: 'string', enum: ['post', 'article', 'podcast', 'talk', 'interview', 'news', 'announcement', 'other'] },
          title: { type: 'string' },
          summary: { type: 'string', description: 'one line: what they said or argued' },
          url: { type: 'string' },
        },
      },
    },
    recentThemes: { ...STRING_ARRAY, maxItems: 6 },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url'],
        properties: { title: { type: 'string' }, url: { type: 'string' } },
      },
    },
  },
};

/** v6 lens scoring output (same shape as ranking) */
export const LENS_SCHEMA: Record<string, unknown> = RANK_SCHEMA;

// ---------- v9: marketing org map (Haiku org inference) ----------
/** per-member classification; ids are the prompt-local p0..pN */
export const ORG_CLASSIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'subfunction', 'seniority', 'noise', 'vendorFunded', 'team', 'entity', 'country', 'responsibilities', 'confidence', 'reason'],
        properties: {
          id: { type: 'string' },
          subfunction: { type: 'string', enum: [...SUBFUNCTIONS] },
          seniority: { type: 'string', enum: [...SENIORITIES] },
          noise: { type: 'string', enum: ['', ...ORG_NOISE_FLAGS] },
          vendorFunded: { type: 'boolean' },
          team: { type: 'string' },
          entity: { type: 'string' },
          country: { type: 'string' },
          responsibilities: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
        },
      },
    },
  },
};

/** suggested managers over the compact roster; managerId null = unsure */
export const ORG_REPORTING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['edges'],
  properties: {
    edges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'managerId', 'confidence', 'reason'],
        properties: {
          id: { type: 'string' },
          managerId: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
        },
      },
    },
  },
};

// ---------- v9: marketing org map (web org research) ----------
/** one research pass: people, structure facts and headcounts — each with the page it came from and a verbatim quote */
export const ORG_RESEARCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['people', 'facts', 'headcounts', 'searchesRun', 'rateLimited'],
  properties: {
    people: {
      type: 'array',
      maxItems: 60,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'title', 'entity', 'country', 'subfunction', 'evidenceUrl', 'quote', 'date'],
        properties: {
          name: { type: 'string' },
          title: { type: 'string' },
          entity: { type: 'string', description: 'legal entity as written on the page, or ""' },
          country: { type: 'string', description: 'ISO 3166 alpha-2 (e.g. DE) or ""' },
          subfunction: { type: 'string', enum: ['', ...SUBFUNCTIONS] },
          evidenceUrl: { type: 'string', description: 'http(s) URL of a page you actually saw' },
          quote: { type: 'string', description: 'verbatim excerpt from that page' },
          date: { type: 'string', description: 'YYYY, YYYY-MM or YYYY-MM-DD of the source; "" if unknown' },
        },
      },
    },
    facts: {
      type: 'array',
      maxItems: 60,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'entity', 'country', 'subject', 'manager', 'evidenceUrl', 'quote', 'confidence'],
        properties: {
          kind: { type: 'string', enum: [...ORG_FACT_KINDS] },
          text: { type: 'string' },
          entity: { type: 'string' },
          country: { type: 'string' },
          subject: { type: 'string', description: 'reporting facts: full name of the person who reports; else ""' },
          manager: { type: 'string', description: 'reporting facts: full name of their manager; else ""' },
          evidenceUrl: { type: 'string' },
          quote: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    headcounts: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'scope', 'count', 'evidenceUrl', 'quote'],
        properties: {
          label: { type: 'string' },
          scope: { type: 'string', enum: ['company', 'function'] },
          count: { type: 'integer', minimum: 0 },
          evidenceUrl: { type: 'string' },
          quote: { type: 'string' },
        },
      },
    },
    searchesRun: { type: 'integer', minimum: 0 },
    rateLimited: { type: 'boolean' },
  },
};
