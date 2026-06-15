/**
 * SkillSearch — lightweight BM25 index for skill retrieval.
 *
 * Instead of injecting every skill into the system prompt, we build a
 * compact inverted index at startup and expose a search() method that
 * returns ranked results in <5 ms for 1 500+ skills.
 *
 * No external dependencies — pure TypeScript BM25 with Okapi TF-IDF.
 */

import type { SkillDefinition } from './types';

// ── BM25 parameters ────────────────────────────────────────────────

const K1 = 1.2; // term-frequency saturation
const B = 0.75; // document-length normalisation

// Field weights: name matches are much more likely to indicate a specialised
// skill than description matches.
const FIELD_WEIGHTS = {
  name: 3.0,
  whenToUse: 1.5,
  description: 1.0,
};

// Bonus added when a query token directly matches a token in the skill name.
const NAME_MATCH_BONUS = 0.25;

// ── Synonym expansion (lightweight, no ML dependency) ───────────────

const RAW_SYNONYMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['test', ['testing', 'spec', 'e2e', 'qa']],
  ['testing', ['test', 'spec', 'e2e', 'qa']],
  ['e2e', ['test', 'testing', 'playwright', 'cypress']],
  ['deploy', ['deployment', 'ci', 'cd', 'shipping', 'release']],
  ['debug', ['debugging', 'troubleshoot', 'diagnose']],
  ['security', ['vulnerability', 'audit', 'penetration', 'appsec']],
  ['refactor', ['refactoring', 'cleanup', 'restructure']],
  ['docker', ['container', 'containerize', 'compose']],
  ['database', ['db', 'sql', 'postgres', 'mysql', 'query']],
  ['api', ['rest', 'graphql', 'endpoint', 'route']],
  ['auth', ['authentication', 'authorization', 'login', 'oauth']],
  ['performance', ['optimization', 'speed', 'latency', 'benchmark']],
  ['monitor', ['observability', 'logging', 'metrics', 'tracing']],
  ['ui', ['frontend', 'component', 'react', 'interface']],
  ['backend', ['server', 'api', 'service']],
  ['ai', ['ml', 'llm', 'model', 'inference']],
  ['doc', ['documentation', 'readme', 'guide']],
  ['i18n', ['internationalization', 'localization', 'translate', 'translation']],
  ['translate', ['translation', 'i18n', 'localization']],
  ['lint', ['format', 'prettier', 'eslint', 'style']],
  ['type', ['typescript', 'typing', 'typecheck']],
];

function buildBidirectionalSynonyms(
  raw: ReadonlyArray<readonly [string, readonly string[]]>,
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const [term, syns] of raw) {
    for (const target of [term, ...syns]) {
      const group = new Set<string>();
      // Add every synonym of the target, including the original term.
      for (const [src, dst] of raw) {
        if (src === target || dst.includes(target)) {
          group.add(src);
          for (const s of dst) group.add(s);
        }
      }
      group.delete(target);
      const existing = map.get(target);
      if (existing === undefined) {
        map.set(target, [...group]);
      } else {
        for (const g of group) {
          if (!existing.includes(g)) existing.push(g);
        }
      }
    }
  }
  return map;
}

const SYNONYMS: ReadonlyMap<string, readonly string[]> = buildBidirectionalSynonyms(RAW_SYNONYMS);

// Common English stopwords to ignore in skill text and queries.
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'it',
  'its', 'they', 'them', 'their', 'we', 'our', 'us', 'i', 'my', 'me', 'you', 'your',
]);

// ── Helpers ─────────────────────────────────────────────────────────

function splitCompoundIdentifier(token: string): string[] {
  // camelCase / PascalCase
  const camel = token.replaceAll(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  // snake_case / kebab-case
  const parts = camel.replaceAll(/[_-]/g, ' ').split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts : [token.toLowerCase()];
}

function tokenize(text: string, options: { removeStopwords?: boolean } = {}): string[] {
  const raw = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const expanded: string[] = [];
  for (const token of raw) {
    if (options.removeStopwords && STOPWORDS.has(token)) continue;
    expanded.push(...splitCompoundIdentifier(token));
  }
  return expanded;
}

function expandWithSynonyms(tokens: readonly string[]): string[] {
  const result = [...tokens];
  for (const token of tokens) {
    const syns = SYNONYMS.get(token);
    if (syns !== undefined) {
      for (const syn of syns) {
        if (!result.includes(syn)) result.push(syn);
      }
    }
  }
  return result;
}

// ── Public types ────────────────────────────────────────────────────

export interface SkillSearchResult {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly source: string;
  readonly path: string;
  readonly score: number;
}

// ── Index ───────────────────────────────────────────────────────────

interface IndexEntry {
  readonly skill: SkillDefinition;
  readonly tokens: readonly string[];
  readonly tokenSet: ReadonlySet<string>;
  readonly nameTokens: ReadonlySet<string>;
  readonly length: number;
}

interface PostingEntry {
  readonly docIndex: number;
  readonly tf: number;
}

export class SkillSearchIndex {
  private entries: IndexEntry[] = [];
  private invertedIndex = new Map<string, PostingEntry[]>();
  private avgDocLength = 0;
  private totalDocs = 0;

  /**
   * Build the index from a list of skill definitions.
   * Runs once at startup; ~50 ms for 1 500 skills.
   */
  build(skills: readonly SkillDefinition[]): void {
    this.entries = [];
    this.invertedIndex.clear();

    for (const skill of skills) {
      const nameTokens = tokenize(skill.name, { removeStopwords: true });
      const descriptionTokens = tokenize(skill.description, { removeStopwords: true });
      const whenToUseTokens = tokenize(skill.metadata.whenToUse ?? '', { removeStopwords: true });

      // Weighted term frequency: a term appearing in the name contributes
      // more than the same term appearing only in the description.
      const weightedTf = new Map<string, number>();
      const addTokens = (tokens: readonly string[], weight: number) => {
        for (const tok of tokens) {
          weightedTf.set(tok, (weightedTf.get(tok) ?? 0) + weight);
        }
      };
      addTokens(nameTokens, FIELD_WEIGHTS.name);
      addTokens(whenToUseTokens, FIELD_WEIGHTS.whenToUse);
      addTokens(descriptionTokens, FIELD_WEIGHTS.description);

      // Expand synonyms after field weighting so synonyms inherit the source
      // field's weight and avoid double-counting.
      const expandedTf = new Map<string, number>();
      for (const [term, weight] of weightedTf) {
        expandedTf.set(term, (expandedTf.get(term) ?? 0) + weight);
        const syns = SYNONYMS.get(term);
        if (syns !== undefined) {
          for (const syn of syns) {
            expandedTf.set(syn, (expandedTf.get(syn) ?? 0) + weight);
          }
        }
      }

      const expandedTokens = [...expandedTf.keys()];
      const tokenSet = new Set(expandedTokens);
      const docLength = [...expandedTf.values()].reduce((sum, w) => sum + w, 0);

      const entry: IndexEntry = {
        skill,
        tokens: expandedTokens,
        tokenSet,
        nameTokens: new Set(nameTokens),
        length: docLength,
      };

      const docIndex = this.entries.length;
      this.entries.push(entry);

      // Add to inverted index
      for (const [term, tf] of expandedTf) {
        const posting = this.invertedIndex.get(term);
        const pEntry: PostingEntry = { docIndex, tf };
        if (posting !== undefined) {
          posting.push(pEntry);
        } else {
          this.invertedIndex.set(term, [pEntry]);
        }
      }
    }

    this.totalDocs = this.entries.length;
    this.avgDocLength =
      this.entries.reduce((sum, e) => sum + e.length, 0) / (this.totalDocs || 1);
  }

  search(query: string, limit = 10): readonly SkillSearchResult[] {
    if (this.totalDocs === 0) return [];

    const baseQueryTokens = tokenize(query, { removeStopwords: true });
    const queryTokens = expandWithSynonyms(baseQueryTokens);
    if (queryTokens.length === 0) return [];

    const scores = new Float64Array(this.totalDocs);

    for (const term of queryTokens) {
      const posting = this.invertedIndex.get(term);
      if (posting === undefined) continue;

      const n = posting.length;
      const idf = Math.log((this.totalDocs - n + 0.5) / (n + 0.5) + 1);

      for (const pe of posting) {
        const docLen = this.entries[pe.docIndex]?.length ?? 0;
        const numerator = pe.tf * (K1 + 1);
        const denominator = pe.tf + K1 * (1 - B + B * (docLen / this.avgDocLength));
        scores[pe.docIndex] = (scores[pe.docIndex] ?? 0) + idf * (numerator / denominator);
      }
    }

    // Boost scores when a query token matches a skill name token. This rewards
    // skills whose topic is literally named in the query, without requiring the
    // model to know the exact skill name in advance.
    for (let i = 0; i < this.totalDocs; i++) {
      const entry = this.entries[i];
      if (entry === undefined) continue;
      let nameMatches = 0;
      for (const token of baseQueryTokens) {
        if (entry.nameTokens.has(token)) nameMatches += 1;
      }
      if (nameMatches > 0) {
        scores[i] = (scores[i] ?? 0) + nameMatches * NAME_MATCH_BONUS;
      }
    }

    const candidates: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < this.totalDocs; i++) {
      const s = scores[i] ?? 0;
      if (s > 0) {
        candidates.push({ index: i, score: s });
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    return candidates.slice(0, limit).map(({ index, score }) => {
      const entry = this.entries[index]!;
      return {
        name: entry.skill.name,
        description: entry.skill.description.slice(0, 200),
        whenToUse: entry.skill.metadata.whenToUse ?? '',
        source: entry.skill.source,
        path: entry.skill.path,
        score: Math.round(score * 100) / 100,
      };
    });
  }

  /** Total number of indexed skills. */
  get size(): number {
    return this.totalDocs;
  }
}
