export const meta = {
  name: 'deep-research',
  description: 'Deep research orchestrator — runs parallel web searches via search(), reads actual pages via fetch(), cross-checks each fact with an adversarial jury, and writes a cited report.',
  whenToUse: 'Use when the user wants a thorough, multi-source, fact-checked answer to a research question backed by real web sources.',
  phases: ['Plan', 'Search', 'Read', 'Group', 'Crosscheck', 'Report'],
};

// ── Tunables ──────────────────────────────────────────────────────
const JURY_SIZE = 3;
const REJECT_QUORUM = 2;
const SOURCE_BUDGET = 12;
const FACT_CAP = 25;
const MAX_FETCH_SIZE = 50_000;

// ── Structured output shapes ──────────────────────────────────────
const PLAN_SHAPE = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The research question, rephrased for clarity.' },
    lines: {
      type: 'array',
      items: { type: 'string' },
      minItems: 3,
      maxItems: 6,
      description: '3-6 complementary search lines covering different facets.',
    },
  },
  required: ['question', 'lines'],
};

const EXTRACT_SHAPE = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'A falsifiable factual claim.' },
          excerpt: { type: 'string', description: 'Supporting quote from the source.' },
          weight: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['statement', 'excerpt', 'weight'],
      },
      minItems: 1,
      maxItems: 5,
    },
    source_tier: { type: 'string', enum: ['primary', 'secondary', 'weak'] },
  },
  required: ['facts', 'source_tier'],
};

const RULING_SHAPE = {
  type: 'object',
  properties: {
    reject: { type: 'boolean', description: 'True if the fact should be rejected.' },
    reason: { type: 'string', description: 'Why you reject or uphold the fact.' },
    certainty: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['reject', 'reason', 'certainty'],
};

const GROUP_SHAPE = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          canonical: { type: 'string', description: 'The canonical statement.' },
          members: { type: 'array', items: { type: 'string' } },
          urls: { type: 'array', items: { type: 'string' } },
        },
        required: ['canonical', 'members', 'urls'],
      },
    },
  },
  required: ['groups'],
};

const REPORT_SHAPE = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: '3-5 sentence direct answer to the question.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          certainty: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['claim', 'evidence', 'sources', 'certainty'],
      },
    },
    limitations: { type: 'string', description: 'What this research could not cover.' },
    followups: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
  },
  required: ['answer', 'findings', 'limitations', 'followups'],
};

// ── Helpers ───────────────────────────────────────────────────────

function canonURL(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}

function extractText(html) {
  // Crude HTML-to-text: strip tags, decode entities, collapse whitespace.
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Main ──────────────────────────────────────────────────────────

const question = typeof args === 'string' ? args : (args && args.question) || '';

if (!question) {
  return { error: 'No question provided. Pass a research question as args.' };
}

// Phase 1: Plan — use LLM to break the question into search lines.
phase('Plan');
const plan = await agent(
  `You are a research planner. Break this question into 3-6 complementary search queries that cover different facets.\n\nQuestion: ${question}\n\nReturn JSON with "question" (rephrased) and "lines" (array of 3-6 search queries).`,
  { schema: PLAN_SHAPE, label: 'planner', phase: 'Plan' }
);

if (!plan || !plan.lines || plan.lines.length === 0) {
  return { error: 'Planning failed — no search lines generated.', question };
}

log(`Plan: ${plan.lines.length} search lines`);

// Phase 2: Search — use native search() for all lines in parallel.
phase('Search');
const seenUrls = new Set();
const allTexts = [];

const searchResults = await parallel(
  plan.lines.map((line) => async () => {
    const results = await search(line);
    const fresh = results.filter((r) => {
      const canon = canonURL(r.url);
      if (seenUrls.has(canon)) return false;
      seenUrls.add(canon);
      return true;
    }).slice(0, 5); // top 5 per line
    return { line, results: fresh };
  })
);

// Collect unique sources, enforce budget.
let candidates = [];
for (const sr of searchResults) {
  for (const r of sr.results) {
    candidates.push(r);
  }
}

if (candidates.length > SOURCE_BUDGET) {
  candidates = candidates.slice(0, SOURCE_BUDGET);
}

log(`Search returned ${candidates.length} unique sources`);

if (candidates.length === 0) {
  return { question, error: 'No search results found.', stats: { lines: plan.lines.length, sourcesRead: 0, factsFound: 0 } };
}

// Phase 3: Read — fetch actual pages and extract facts.
phase('Read');
const allFacts = [];

await parallel(
  candidates.map((source) => async () => {
    try {
      const { ok, status, body } = await fetch(source.url);
      if (!ok || status !== 200 || body.length === 0) {
        log(`Fetch failed: ${source.url} (${status})`);
        return;
      }
      const text = extractText(body).slice(0, MAX_FETCH_SIZE);
      if (text.length < 50) return;

      const extraction = await agent(
        `Extract 1-5 falsifiable facts from this page content.\n\nURL: ${source.url}\nTitle: ${source.title}\n\nContent:\n${text}\n\nFor each fact, provide a statement, a supporting excerpt, and a weight (high/medium/low). Also rate the source tier (primary/secondary/weak).`,
        { schema: EXTRACT_SHAPE, label: 'read:' + canonURL(source.url).slice(0, 20), phase: 'Read' }
      ).catch(() => null);

      if (extraction && extraction.facts) {
        for (const fact of extraction.facts) {
          allFacts.push({ ...fact, url: source.url, title: source.title });
        }
      }
    } catch (e) {
      log(`Error reading ${source.url}: ${e}`);
    }
  })
);

log(`Extracted ${allFacts.length} facts from ${candidates.length} sources`);

if (allFacts.length === 0) {
  return {
    question,
    error: 'No facts extracted from any source.',
    stats: { lines: plan.lines.length, sourcesRead: candidates.length, factsFound: 0 },
  };
}

// Phase 4: Group — cluster similar facts.
phase('Group');
const topFacts = allFacts.slice(0, FACT_CAP);
const grouped = await agent(
  `Group these facts into canonical clusters. Facts asserting the same thing should be merged.\n\nFacts:\n${JSON.stringify(topFacts.map((f, i) => ({ id: i, ...f })), null, 2)}\n\nReturn groups with a canonical statement, member indices, and combined URLs.`,
  { schema: GROUP_SHAPE, label: 'grouper', phase: 'Group' }
);

let groups = (grouped && grouped.groups) || topFacts.map((f, i) => ({
  canonical: f.statement,
  members: [String(i)],
  urls: [f.url],
}));

log(`Grouped into ${groups.length} clusters`);

// Phase 5: Crosscheck (adversarial jury).
phase('Crosscheck');
const checked = await parallel(
  groups.map((fact) => () =>
    parallel(
      Array(JURY_SIZE).fill(0).map((_, n) =>
        agent(
          `You are juror ${n + 1} of ${JURY_SIZE}. Your job is to TRY TO REJECT this fact.\n\nFact: ${fact.canonical}\n\nExamine it critically. If you can find a reason to reject it (unsupported, contradicted, vague, misleading), do so. Only uphold it if the evidence is solid.\n\nReturn your ruling: reject (true/false), reason, certainty.`,
          { schema: RULING_SHAPE, label: `j${n}:${fact.canonical.slice(0, 20)}`, phase: 'Crosscheck' }
        ).catch(() => null)
      )
    ).then((rulings) => ({ fact, rulings }))
  )
);

const upheld = [];
const dropped = [];

for (const { fact, rulings } of checked) {
  const valid = rulings.filter((r) => r !== null);
  const rejects = valid.filter((r) => r.reject).length;
  const cast = valid.length;

  if (cast >= REJECT_QUORUM && rejects < REJECT_QUORUM) {
    upheld.push(fact);
  } else {
    dropped.push({ fact, reason: `${rejects}/${cast} jurors rejected` });
  }
}

log(`Crosscheck: ${upheld.length} upheld, ${dropped.length} dropped`);

// Phase 6: Report.
phase('Report');
const report = await agent(
  `Write a research report based on these upheld facts.\n\nQuestion: ${question}\n\nUpheld facts:\n${JSON.stringify(upheld, null, 2)}\n\nWrite a 3-5 sentence direct answer, then list findings with evidence, sources, and certainty. Note limitations and suggest 2-4 follow-up questions.`,
  { schema: REPORT_SHAPE, label: 'reporter', phase: 'Report' }
);

if (!report) {
  return {
    question,
    answer: 'Report generation failed. Raw upheld facts attached.',
    findings: upheld.map((f) => ({ claim: f.canonical, evidence: '', sources: f.urls || [], certainty: 'medium' })),
    limitations: 'Report agent failed to generate a structured report.',
    followups: [],
    rejected: dropped,
    sources: Array.from(seenUrls),
    stats: { lines: plan.lines.length, sourcesRead: candidates.length, factsFound: allFacts.length, factsChecked: groups.length, upheld: upheld.length, dropped: dropped.length },
  };
}

return {
  question,
  ...report,
  rejected: dropped,
  sources: Array.from(seenUrls),
  stats: { lines: plan.lines.length, sourcesRead: candidates.length, factsFound: allFacts.length, factsChecked: groups.length, upheld: upheld.length, dropped: dropped.length },
};