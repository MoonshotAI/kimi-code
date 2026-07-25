/**
 * Knowledge Base — TypeScript adapter.
 *
 * Spawns the `kimi-knowledge` Rust binary and parses JSON output.
 * Used by the contextInjector to fetch relevant standards before each turn.
 */

import { execFileSync } from 'child_process';
import { resolve } from 'path';

const BINARY = process.env.KIMI_KNOWLEDGE_BIN ?? 'kimi-knowledge';

export interface KnowledgeSearchResult {
  entry: {
    id: string;
    category: string;
    title: string;
    content: string;
    tags: string[];
    scope: string | null;
    confidence: number;
    source: string;
    created_at: string;
    updated_at: string;
  };
  relevance: number;
  match_source: string[];
}

export interface KnowledgeAddInput {
  title: string;
  category: string;
  content: string;
  tags?: string[];
  scope?: string;
  source?: string;
  confidence?: number;
}

function exec(args: string[], dbPath?: string): string {
  const fullArgs = dbPath ? ['--db', dbPath, '--json', ...args] : ['--json', ...args];
  return execFileSync(BINARY, fullArgs, {
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

/**
 * Search the knowledge base for entries relevant to the current context.
 */
export function knowledgeSearch(
  query: string,
  options?: { scopePath?: string; tags?: string[]; limit?: number; minConfidence?: number; dbPath?: string },
): KnowledgeSearchResult[] {
  const args = ['search', query];
  if (options?.scopePath) args.push('--scope', options.scopePath);
  if (options?.tags?.length) args.push('--tags', options.tags.join(','));
  if (options?.limit) args.push('--limit', String(options.limit));
  if (options?.minConfidence !== undefined) args.push('--min-confidence', String(options.minConfidence));

  try {
    const output = exec(args, options?.dbPath);
    return JSON.parse(output);
  } catch {
    return [];
  }
}

/**
 * Add a new entry to the knowledge base (used by the AI learner).
 */
export function knowledgeAdd(input: KnowledgeAddInput, dbPath?: string): string | null {
  const args = ['add', '--title', input.title, '--content', input.content, '--category', input.category];
  if (input.tags?.length) args.push('--tags', input.tags.join(','));
  if (input.scope) args.push('--scope', input.scope);
  if (input.source) args.push('--source', input.source);
  if (input.confidence !== undefined) args.push('--confidence', String(input.confidence));

  try {
    const output = exec(args, dbPath);
    const result = JSON.parse(output);
    return result.id;
  } catch {
    return null;
  }
}

/**
 * Confirm an AI-learned entry.
 */
export function knowledgeConfirm(id: string, dbPath?: string): boolean {
  try {
    exec(['confirm', id], dbPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove/reject an entry.
 */
export function knowledgeReject(id: string, dbPath?: string): boolean {
  try {
    exec(['reject', id], dbPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format search results for injection into system-reminder.
 * Respects a token budget.
 */
export function formatForInjection(results: KnowledgeSearchResult[], maxTokens = 800): string {
  if (results.length === 0) return '';

  const lines: string[] = ['[Knowledge Base — Relevant Standards]', ''];
  let tokensUsed = 10; // header overhead

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const line = `${i + 1}. [${r.entry.category}] ${r.entry.title}\n   ${r.entry.content.split('\n')[0]}`;
    const lineTokens = Math.ceil(line.length / 4);

    if (tokensUsed + lineTokens > maxTokens) break;
    lines.push(line);
    lines.push('');
    tokensUsed += lineTokens;
  }

  return lines.join('\n');
}
