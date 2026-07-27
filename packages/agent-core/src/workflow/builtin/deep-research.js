/**
 * deep-research — built-in dynamic workflow for Kimi Code.
 *
 * Multi-source deep research with adversarial verification:
 *   Scope → (Search × angles → dedupe → Fetch+Extract) → Verify (multi-vote) → Synthesize
 *
 * Agent-call budget (default maxAgentCalls = 50):
 *   1 scope + ≤6 search + ≤12 fetch + ≤10×3 verify + 1 synthesize = 50.
 */

export const meta = {
  name: 'deep-research',
  description:
    'Deep research harness — decomposes a question into search angles, fans out web searches, fetches and extracts falsifiable claims, verifies them adversarially, and synthesizes a cited report.',
  whenToUse:
    'When the user wants a thorough, multi-source, fact-checked research report on a topic. If the question is too vague to research meaningfully (no budget/use-case/region constraints), ask 2-3 clarifying questions first and pass the refined question as args.',
  argumentHint: '<research question>',
  phases: [
    { title: 'Scope', detail: 'Decompose the question into complementary search angles' },
    { title: 'Search', detail: 'One web-search agent per angle, running in parallel' },
    { title: 'Fetch', detail: 'Deduplicate URLs, fetch sources, extract falsifiable claims' },
    { title: 'Verify', detail: 'Adversarial multi-vote verification per claim' },
    { title: 'Synthesize', detail: 'Merge confirmed claims, rank confidence, cite sources' },
  ],
};

// Budget: 1 + 6 + 12 + (10 × 3) + 1 = 50 agent calls (the default limit).
const MAX_FETCH = 12;
const MAX_VERIFY_CLAIMS = 10;
const VOTES_PER_CLAIM = 3;
const REFUTATIONS_REQUIRED = 2;

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['question', 'angles'],
  properties: {
    question: { type: 'string' },
    strategy: { type: 'string' },
    angles: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['label', 'query'],
        properties: {
          label: { type: 'string' },
          query: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        required: ['url', 'title', 'relevance'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
          relevance: { enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

const EXTRACT_SCHEMA = {
  type: 'object',
  required: ['sourceQuality', 'claims'],
  properties: {
    sourceQuality: { enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'] },
    publishDate: { type: 'string' },
    claims: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        required: ['claim', 'quote', 'importance'],
        properties: {
          claim: { type: 'string' },
          quote: { type: 'string' },
          importance: { enum: ['central', 'supporting', 'tangential'] },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'evidence', 'confidence'],
  properties: {
    refuted: { type: 'boolean' },
    evidence: { type: 'string' },
    confidence: { enum: ['high', 'medium', 'low'] },
    counterSource: { type: 'string' },
  },
};

const REPORT_SCHEMA = {
  type: 'object',
  required: ['summary', 'findings', 'caveats'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'confidence', 'sources', 'evidence'],
        properties: {
          claim: { type: 'string' },
          confidence: { enum: ['high', 'medium', 'low'] },
          sources: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string' },
        },
      },
    },
    caveats: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
};

const QUESTION = typeof args === 'string' ? args.trim() : '';
if (!QUESTION) {
  return {
    error: 'No research question provided. Pass it as args: /workflow run deep-research <question>.',
  };
}

// ─── Scope ──────────────────────────────────────────────────────────────────
phase('Scope');
const scope = await agent(
  'You decompose research questions into complementary web-search angles.\n\n' +
    '## Question\n' + QUESTION + '\n\n' +
    '## Task\n' +
    'Produce 4-6 distinct search queries that together cover the question from different angles ' +
    '(e.g. primary/authoritative, technical detail, recent developments, skeptical/contrarian, practitioner experience). ' +
    'Pick angles that fit the domain of the question. Make each query specific enough to surface high-signal results.\n' +
    'Return the question (lightly normalized if needed), a one-sentence decomposition strategy, and the angles.',
  { label: 'scope', schema: SCOPE_SCHEMA },
);
if (!scope) {
  return { error: 'Scope agent returned no result — cannot decompose the research question.' };
}
log('Question: ' + QUESTION.slice(0, 100));
log('Angles: ' + scope.angles.map((a) => a.label).join(', '));

// ─── Shared dedupe state (accumulates as pipeline items complete) ───────────
const normURL = (u) => {
  try {
    const parsed = new URL(u);
    return (parsed.hostname.replace(/^www\./, '') + parsed.pathname.replace(/\/$/, '')).toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
};
const seen = new Map();
const urlDupes = [];
const budgetDropped = [];
const relevanceRank = { high: 0, medium: 1, low: 2 };
let fetchSlots = MAX_FETCH;

// ─── Search → dedupe → Fetch+Extract (items flow without a barrier) ─────────
phase('Search');
const perAngle = await pipeline(
  scope.angles,
  async (angle) => {
    let result = null;
    try {
      result = await agent(
        'You are a web searcher.\n\n' +
          'Research question: "' + QUESTION + '"\n' +
          'Your angle: **' + angle.label + '** — ' + (angle.rationale || '') + '\n' +
          'Search query: `' + angle.query + '`\n\n' +
          '## Task\n' +
          'Use WebSearch with the query above (refine it if needed). Return the 4-6 most relevant results, ' +
          'ranked by relevance to the ORIGINAL question. Skip SEO spam and content farms. ' +
          'Include a short snippet explaining why each result matters.',
        { label: 'search:' + angle.label, phase: 'Search', schema: SEARCH_SCHEMA },
      );
    } catch (e) {
      log('search failed: ' + angle.label + ' — ' + (e && e.message ? e.message : e));
      return null;
    }
    if (!result) return null;
    log('search:' + angle.label + ' → ' + result.results.length + ' results');
    return { angle: angle.label, results: result.results };
  },
  (searchResult) => {
    const sorted = searchResult.results
      .slice()
      .sort((a, b) => relevanceRank[a.relevance] - relevanceRank[b.relevance]);
    const novel = [];
    for (const r of sorted) {
      const key = normURL(r.url);
      if (seen.has(key)) {
        urlDupes.push({ url: r.url, angle: searchResult.angle });
        continue;
      }
      if (fetchSlots <= 0) {
        budgetDropped.push({ url: r.url, angle: searchResult.angle });
        continue;
      }
      seen.set(key, searchResult.angle);
      fetchSlots -= 1;
      novel.push(r);
    }
    if (novel.length === 0) return null;
    return parallel(
      novel.map((source) => async () => {
        try {
          const extracted = await agent(
            'You extract falsifiable claims from a source.\n\n' +
              'Research question: "' + QUESTION + '"\n' +
              'URL: ' + source.url + '\n' +
              'Title: ' + source.title + '\n\n' +
              '## Task\n' +
              '1. Use WebFetch to retrieve the page.\n' +
              '2. Rate the source quality: primary research/official docs, secondary reporting, blog/opinion, forum, or unreliable.\n' +
              '3. Extract 2-5 FALSIFIABLE claims relevant to the research question. Each must be a concrete, ' +
              'checkable statement with a direct supporting quote, rated central/supporting/tangential.\n' +
              'If the page is unreachable, paywalled, or irrelevant, return an empty claims list with sourceQuality "unreliable".',
            { label: 'fetch:' + normURL(source.url).slice(0, 40), phase: 'Fetch', schema: EXTRACT_SCHEMA },
          );
          if (!extracted) return null; // user skip / abstention — drop quietly
          return {
            url: source.url,
            title: source.title,
            angle: searchResult.angle,
            sourceQuality: extracted.sourceQuality,
            publishDate: extracted.publishDate,
            claims: extracted.claims.map((c) => ({
              claim: c.claim,
              quote: c.quote,
              importance: c.importance,
              sourceUrl: source.url,
              sourceQuality: extracted.sourceQuality,
            })),
          };
        } catch (e) {
          log('fetch failed: ' + source.url + ' — ' + (e && e.message ? e.message : e));
          return {
            url: source.url,
            title: source.title,
            angle: searchResult.angle,
            sourceQuality: 'unreliable',
            claims: [],
          };
        }
      }),
    );
  },
);

const sources = perAngle.flat().filter(Boolean);
const allClaims = sources.flatMap((s) => s.claims);
log('Fetched ' + sources.length + ' sources → ' + allClaims.length + ' claims');

const stats = {
  angles: scope.angles.length,
  sourcesFetched: sources.length,
  claimsExtracted: allClaims.length,
  urlDupes: urlDupes.length,
  budgetDropped: budgetDropped.length,
};

const sourceList = () =>
  sources.map((s) => ({ url: s.url, quality: s.sourceQuality, angle: s.angle, claimCount: s.claims.length }));

if (allClaims.length === 0) {
  return {
    question: QUESTION,
    summary:
      'No claims could be extracted. ' + sources.length + ' sources fetched, all empty or failed.',
    findings: [],
    refuted: [],
    sources: sourceList(),
    stats: { ...stats, claimsVerified: 0, confirmed: 0, killed: 0 },
  };
}

// ─── Verify: adversarial multi-vote per claim ───────────────────────────────
// Barrier is intentional: the full claim pool must exist before ranking.
phase('Verify');
const importanceRank = { central: 0, supporting: 1, tangential: 2 };
const qualityRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 };
const ranked = allClaims
  .slice()
  .sort(
    (a, b) =>
      importanceRank[a.importance] - importanceRank[b.importance] ||
      qualityRank[a.sourceQuality] - qualityRank[b.sourceQuality],
  )
  .slice(0, MAX_VERIFY_CLAIMS);

log('Verifying top ' + ranked.length + ' claims (' + VOTES_PER_CLAIM + ' votes each)');

const adjudicated = (
  await parallel(
    ranked.map((claim) => async () => {
      const verdicts = (
        await parallel(
          Array.from({ length: VOTES_PER_CLAIM }, (_, v) => async () => {
            try {
              return await agent(
                'You are an adversarial claim verifier (vote ' + (v + 1) + ' of ' + VOTES_PER_CLAIM + '). ' +
                  'Be skeptical: try to REFUTE the claim. ' + REFUTATIONS_REQUIRED + ' or more refutations kill it.\n\n' +
                  '## Research question\n' + QUESTION + '\n\n' +
                  '## Claim under review\n"' + claim.claim + '"\n' +
                  'Source: ' + claim.sourceUrl + ' (' + claim.sourceQuality + ')\n' +
                  'Supporting quote: "' + claim.quote + '"\n\n' +
                  '## Checklist\n' +
                  '1. Is the claim actually supported by the quote, or an overreach?\n' +
                  '2. WebSearch for contradicting evidence from credible sources.\n' +
                  '3. Is the source quality sufficient for the strength of the claim?\n' +
                  '4. Is it outdated, marketing fluff, or cherry-picked?\n' +
                  'refuted=true unless the claim is well-supported, current, and properly sourced. Evidence must be specific.',
                { label: 'vote:' + (v + 1) + ':' + claim.claim.slice(0, 30), phase: 'Verify', schema: VERDICT_SCHEMA },
              );
            } catch {
              return null; // verifier error counts as abstention, never as survival
            }
          }),
        )
      ).filter(Boolean);
      const refutedVotes = verdicts.filter((verdict) => verdict.refuted).length;
      const abstained = VOTES_PER_CLAIM - verdicts.length;
      // A claim survives only when actually adjudicated: a quorum of valid
      // votes AND fewer than REFUTATIONS_REQUIRED refuting. Mass abstention
      // must not leak into the report as "confirmed".
      const survives = verdicts.length >= REFUTATIONS_REQUIRED && refutedVotes < REFUTATIONS_REQUIRED;
      log(
        '"' + claim.claim.slice(0, 60) + (claim.claim.length > 60 ? '…' : '') + '": ' +
          (verdicts.length - refutedVotes) + '-' + refutedVotes +
          (abstained > 0 ? ' (' + abstained + ' abstain)' : '') +
          (survives ? ' ✓' : ' ✗'),
      );
      return { ...claim, verdicts, refutedVotes, survives };
    }),
  )
).filter(Boolean);

const confirmed = adjudicated.filter((c) => c.survives);
const killed = adjudicated.filter((c) => !c.survives);
log('Verify done: ' + confirmed.length + ' confirmed, ' + killed.length + ' killed');

const refutedList = () =>
  killed.map((c) => ({
    claim: c.claim,
    vote: c.verdicts.length - c.refutedVotes + '-' + c.refutedVotes,
    source: c.sourceUrl,
  }));

if (confirmed.length === 0) {
  return {
    question: QUESTION,
    summary:
      'All ' + adjudicated.length + ' verified claims were refuted or left unadjudicated. ' +
      'Research inconclusive — sources may be weak or claims overstated.',
    findings: [],
    refuted: refutedList(),
    sources: sourceList(),
    stats: { ...stats, claimsVerified: adjudicated.length, confirmed: 0, killed: killed.length },
  };
}

// ─── Synthesize ─────────────────────────────────────────────────────────────
phase('Synthesize');
const confidenceRank = { high: 0, medium: 1, low: 2 };
const evidenceBlock = confirmed
  .map((c, i) => {
    const best = c.verdicts
      .filter((v) => !v.refuted)
      .sort((a, b) => confidenceRank[a.confidence] - confidenceRank[b.confidence])[0];
    return (
      '### [' + i + '] ' + c.claim + '\n' +
      'Vote: ' + (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes +
      ' · Source: ' + c.sourceUrl + ' (' + c.sourceQuality + ')\n' +
      'Quote: "' + c.quote + '"\n' +
      'Verifier evidence (' + (best ? best.confidence : 'n/a') + '): ' + (best ? best.evidence : 'n/a') + '\n'
    );
  })
  .join('\n');

let report = null;
try {
  report = await agent(
    'You write research reports.\n\n' +
      'Question: ' + QUESTION + '\n\n' +
      confirmed.length + ' claims survived adversarial verification. Merge and synthesize.\n\n' +
      '## Confirmed claims\n' + evidenceBlock + '\n' +
      (killed.length > 0
        ? '## Refuted claims (for transparency)\n' +
          killed.map((c) => '- "' + c.claim + '" (' + c.sourceUrl + ')').join('\n') + '\n\n'
        : '\n') +
      '## Instructions\n' +
      '1. Merge semantically duplicate claims, combining their sources.\n' +
      '2. Group related claims into findings that directly answer the question.\n' +
      '3. Assign confidence per finding (high = multiple primary sources / unanimous votes; low = single weak source).\n' +
      '4. Write a 3-5 sentence executive summary answering the question.\n' +
      '5. Note caveats and 2-4 open questions that emerged.',
    { label: 'synthesize', schema: REPORT_SCHEMA },
  );
} catch (e) {
  log('synthesize failed: ' + (e && e.message ? e.message : e));
}

if (!report) {
  // Salvage: return verified claims unmerged instead of discarding the run.
  return {
    question: QUESTION,
    summary:
      'Synthesis step was skipped or failed — returning ' + confirmed.length + ' verified claims unmerged.',
    findings: [],
    confirmedRaw: confirmed.map((c) => ({
      claim: c.claim,
      source: c.sourceUrl,
      quote: c.quote,
      vote: c.verdicts.length - c.refutedVotes + '-' + c.refutedVotes,
    })),
    refuted: refutedList(),
    sources: sourceList(),
    stats: { ...stats, claimsVerified: adjudicated.length, confirmed: confirmed.length, killed: killed.length },
  };
}

return {
  question: QUESTION,
  summary: report.summary,
  findings: report.findings,
  caveats: report.caveats,
  openQuestions: report.openQuestions,
  refuted: refutedList(),
  sources: sourceList(),
  stats: {
    ...stats,
    claimsVerified: adjudicated.length,
    confirmed: confirmed.length,
    killed: killed.length,
    afterSynthesis: report.findings.length,
  },
};
