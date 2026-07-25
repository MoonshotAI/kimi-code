/**
 * Knowledge Base — Context Injector Provider.
 *
 * Registers with kimi-code's contextInjectorService to inject relevant
 * knowledge base entries as a system-reminder before each turn.
 *
 * Integration point: this module is loaded by the agent lifecycle and
 * registers a `knowledge` provider that fires on each new turn.
 */

import { knowledgeSearch, formatForInjection, type KnowledgeSearchResult } from './adapter';

export interface InjectorContext {
  /** Current file paths being worked on */
  filePaths: string[];
  /** Latest user message text */
  userMessage: string;
  /** Whether this is a new turn */
  isNewTurn: boolean;
}

export interface InjectorConfig {
  /** Max tokens to inject */
  maxTokens: number;
  /** Max entries to inject */
  maxEntries: number;
  /** Min confidence threshold */
  minConfidence: number;
  /** Database path override */
  dbPath?: string;
}

const DEFAULT_CONFIG: InjectorConfig = {
  maxTokens: 800,
  maxEntries: 5,
  minConfidence: 0.5,
};

/**
 * Extract search signals from the current context.
 * Combines file paths (for scope matching) and user message keywords (for FTS).
 */
function extractSearchSignals(ctx: InjectorContext): { query: string; scopePath?: string; tags: string[] } {
  // Use the most specific file path as scope
  const scopePath = ctx.filePaths.length > 0 ? ctx.filePaths[0] : undefined;

  // Extract keywords from user message (simple: first 50 chars, split on spaces)
  const words = ctx.userMessage
    .slice(0, 200)
    .replace(/[`"'()[\]{}]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const query = words.slice(0, 10).join(' ');

  // Detect technology tags from file extensions and paths
  const tags: string[] = [];
  for (const fp of ctx.filePaths) {
    if (fp.endsWith('.ts') || fp.endsWith('.tsx')) tags.push('typescript');
    if (fp.endsWith('.rs')) tags.push('rust');
    if (fp.endsWith('.vue')) tags.push('vue');
    if (fp.includes('test')) tags.push('testing');
    if (fp.includes('agent-core')) tags.push('agent-core');
  }

  return { query, scopePath, tags: [...new Set(tags)] };
}

/**
 * The knowledge injection provider function.
 * Called by contextInjectorService on each new turn.
 *
 * Returns formatted knowledge entries as a string for system-reminder injection,
 * or undefined if no relevant entries found.
 */
export function knowledgeInjectionProvider(
  ctx: InjectorContext,
  config: InjectorConfig = DEFAULT_CONFIG,
): string | undefined {
  if (!ctx.isNewTurn) return undefined;

  const { query, scopePath, tags } = extractSearchSignals(ctx);

  // Skip injection if we have no search signals
  if (!query && !scopePath && tags.length === 0) return undefined;

  const results = knowledgeSearch(query || '', {
    scopePath,
    tags,
    limit: config.maxEntries,
    minConfidence: config.minConfidence,
    dbPath: config.dbPath,
  });

  if (results.length === 0) return undefined;

  const formatted = formatForInjection(results, config.maxTokens);
  return formatted || undefined;
}

/**
 * Register the knowledge base as a context injection provider.
 *
 * Usage in agent-core-v2:
 * ```typescript
 * import { knowledgeInjectionProvider } from './knowledge/injector';
 *
 * dynamicInjector.register('knowledge', ({ isNewTurn }) => {
 *   if (!isNewTurn) return undefined;
 *   return knowledgeInjectionProvider({
 *     isNewTurn,
 *     filePaths: getCurrentFilePaths(),
 *     userMessage: getLatestUserMessage(),
 *   });
 * });
 * ```
 */
export function createKnowledgeProvider(config?: Partial<InjectorConfig>) {
  const mergedConfig: InjectorConfig = { ...DEFAULT_CONFIG, ...config };

  return (ctx: InjectorContext): string | undefined => {
    return knowledgeInjectionProvider(ctx, mergedConfig);
  };
}
