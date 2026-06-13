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

// ── Synonym expansion (lightweight, no ML dependency) ───────────────

const SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map([
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
]);

// ── Helpers ─────────────────────────────────────────────────────────

function splitCompoundIdentifier(token: string): string[] {
  // camelCase / PascalCase
  const camel = token.replaceAll(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  // snake_case / kebab-case
  const parts = camel.replaceAll(/[_-]/g, ' ').split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts : [token.toLowerCase()];
}

function tokenize(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);

  const expanded: string[] = [];
  for (const token of raw) {
    expanded.push(...splitCompoundIdentifier(token));
  }
  return expanded;
}

function expandWithSynonyms(tokens: readonly string[]): string[] {
  const result = [...tokens];
  for (const token of tokens) {
    const syns = SYNONYMS.get(token);
    if (syns !== undefined) {
      result.push(...syns);
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
      const searchText = [
        skill.name,
        skill.description,
        skill.metadata.whenToUse ?? '',
      ].join(' ');

      const baseTokens = tokenize(searchText);
      const expandedTokens = expandWithSynonyms(baseTokens);
      const tokenSet = new Set(expandedTokens);

      const entry: IndexEntry = {
        skill,
        tokens: expandedTokens,
        tokenSet,
        length: expandedTokens.length,
      };

      const docIndex = this.entries.length;
      this.entries.push(entry);

      // Build term frequency map for this document
      const tf = new Map<string, number>();
      for (const tok of expandedTokens) {
        tf.set(tok, (tf.get(tok) ?? 0) + 1);
      }

      // Add to inverted index
      for (const [term, count] of tf) {
        const posting = this.invertedIndex.get(term);
        const pEntry: PostingEntry = { docIndex, tf: count };
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

    const queryTokens = expandWithSynonyms(tokenize(query));
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
