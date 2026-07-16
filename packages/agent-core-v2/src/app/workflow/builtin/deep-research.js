export const meta = {
  name: 'deep-research',
  description: 'Deep research orchestrator — runs parallel web searches, reads the strongest sources, cross-checks each fact with an adversarial jury, and writes a cited report.',
  whenToUse: 'Use when the user wants a thorough, multi-source, fact-checked answer to a research question.',
  phases: ['Plan', 'Search', 'Extract', 'Group', 'Crosscheck', 'Report'],
};

// ── Tunables ──────────────────────────────────────────────────────
const JURY_SIZE = 3;
const REJECT_QUORUM = 2;
const SOURCE_BUDGET = 15;
const FACT_CAP = 25;

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

const HITS_SHAPE = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          fit: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['url', 'title', 'fit'],
      },
      minItems: 4,
      maxItems: 6,
    },
  },
  required: ['results'],
};

const READ_SHAPE = {
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
      minItems: 2,
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
    counter: { type: 'string', description: 'A counter-argument if rejecting.' },
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
    followups: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 4,
    },
  },
  required: ['answer', 'findings', 'limitations', 'followups'],
};

// ── Helpers ───────────────────────────────────────────────────────

function canonURL(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, '');
    let path = u.pathname.replace(/\/$/, '');
    return host + path;
  } catch {
    return url;
  }
}

// ── Main ──────────────────────────────────────────────────────────

const question = typeof args === 'string' ? args : (args && args.question) || '';

if (!question) {
  return { error: 'No question provided. Pass a research question as args.' };
}

// Phase 1: Plan
phase('Plan');
const plan = await agent(
  `You are a research planner. Break this question into 3-6 complementary search lines that cover different facets.\n\nQuestion: ${question}\n\nReturn JSON with "question" (rephrased) and "lines" (array of 3-6 search queries).`,
  { schema: PLAN_SHAPE, label: 'planner', phase: 'Plan' }
);

if (!plan || !plan.lines || plan.lines.length === 0) {
  return { error: 'Planning failed — no search lines generated.', question };
}

log(`Plan: ${plan.lines.length} search lines`);

// Phase 2-3: Search → Extract (streamed via pipeline)
phase('Search');
const seenUrls = new Set();
let sourcesRead = 0;
const allFacts = [];

const searchReadResults = await pipeline(
  plan.lines,
  // Stage 1: Search
  async (line) => {
    const hits = await agent(
      `Search the web for: "${line}"\n\nReturn 4-6 results with url, title, and fit (high/medium/low). Choose diverse, authoritative sources.`,
      { schema: HITS_SHAPE, label: 'search:' + line.slice(0, 30), phase: 'Search' }
    );
    return hits || { results: [] };
  },
  // Stage 2: Read
  async (hits) => {
    const fresh = (hits.results || []).filter((h) => {
      const canon = canonURL(h.url);
      if (seenUrls.has(canon)) return false;
      seenUrls.add(canon);
      return true;
    });

    // Enforce source budget.
    let toRead = fresh;
    if (sourcesRead + fresh.length > SOURCE_BUDGET) {
      const remaining = SOURCE_BUDGET - sourcesRead;
      toRead = fresh
        .sort((a, b) => (a.fit === 'high' ? -1 : 1) - (b.fit === 'high' ? -1 : 1))
        .slice(0, Math.max(0, remaining));
    }

    sourcesRead += toRead.length;

    const reads = await parallel(
      toRead.map((source) => () =>
        agent(
          `Read this page and extract 2-5 falsifiable facts.\n\nURL: ${source.url}\nTitle: ${source.title}\n\nFor each fact, provide a statement, a supporting excerpt, and a weight (high/medium/low). Also rate the source tier (primary/secondary/weak).`,
          { schema: READ_SHAPE, label: 'read:' + canonURL(source.url).slice(0, 20), phase: 'Extract' }
        ).catch(() => ({ facts: [], source_tier: 'weak' }))
      )
    );

    for (const read of reads) {
      if (read && read.facts) {
        for (const fact of read.facts) {
          allFacts.push(fact);
        }
      }
    }

    return reads;
  }
);

log(`Extracted ${allFacts.length} facts from ${sourcesRead} sources`);

if (allFacts.length === 0) {
  return {
    question,
    error: 'No facts extracted from any source.',
    stats: { lines: plan.lines.length, sourcesRead, factsFound: 0 },
  };
}

// Phase 4: Group
phase('Group');
const topFacts = allFacts.slice(0, FACT_CAP);
const grouped = await agent(
  `Group these facts into canonical clusters. Facts asserting the same thing should be merged.\n\nFacts:\n${JSON.stringify(topFacts.map((f, i) => ({ id: i, ...f })), null, 2)}\n\nReturn groups with a canonical statement, member indices, and combined URLs.`,
  { schema: GROUP_SHAPE, label: 'grouper', phase: 'Group' }
);

let groups = (grouped && grouped.groups) || topFacts.map((f, i) => ({
  canonical: f.statement,
  members: [String(i)],
  urls: [],
}));

log(`Grouped into ${groups.length} clusters`);

// Phase 5: Crosscheck (adversarial jury)
phase('Crosscheck');
const checked = await parallel(
  groups.map((fact, fi) => () =>
    parallel(
      Array(JURY_SIZE).fill(0).map((_, n) =>
        agent(
          `You are juror ${n + 1} of ${JURY_SIZE}. Your job is to TRY TO REJECT this fact.\n\nFact: ${fact.canonical}\n\nExamine it critically. If you can find a reason to reject it (unsupported, contradicted, vague, misleading), do so. Only uphold it if the evidence is solid.\n\nReturn your ruling: reject (true/false), reason, certainty, and a counter-argument if rejecting.`,
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

// Phase 6: Report
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
    stats: {
      lines: plan.lines.length,
      sourcesRead,
      factsFound: allFacts.length,
      factsChecked: groups.length,
      upheld: upheld.length,
      dropped: dropped.length,
    },
  };
}

return {
  question,
  ...report,
  rejected: dropped,
  sources: Array.from(seenUrls),
  stats: {
    lines: plan.lines.length,
    sourcesRead,
    factsFound: allFacts.length,
    factsChecked: groups.length,
    upheld: upheld.length,
    dropped: dropped.length,
  },
};
