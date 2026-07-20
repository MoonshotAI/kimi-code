/**
 * WebSearchTool — host-injected web search.
 *
 * kimi-core defines the interface; the host provides the real search
 * implementation via `WebSearchProvider`. If no provider is supplied,
 * the tool should not be registered (not exposed to the LLM).
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import DESCRIPTION from './web-search.md?raw';

// ── Provider interface (host-injected) ───────────────────────────────

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  siteName?: string;
}

export interface WebSearchProvider {
  search(query: string, options?: { toolCallId?: string }): Promise<WebSearchResult[]>;
}

// ── Input schema ─────────────────────────────────────────────────────

export const WebSearchInputSchema = z.object({
  query: z.string().describe('The query text to search for.'),
});

export type WebSearchInput = z.Infer<typeof WebSearchInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

export class WebSearchTool implements BuiltinTool<WebSearchInput> {
  readonly name = 'WebSearch' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WebSearchInputSchema);
  constructor(private readonly provider: WebSearchProvider) {}

  resolveExecution(args: WebSearchInput): ToolExecution {
    const preview = args.query.length > 40 ? `${args.query.slice(0, 40)}…` : args.query;
    return {
      accesses: ToolAccesses.none(),
      description: `Searching: ${preview}`,
      display: { kind: 'search', query: args.query },
      approvalRule: literalRulePattern(this.name, args.query),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.query),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: WebSearchInput,
    {
    toolCallId,
    }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const opts: { toolCallId?: string } = { toolCallId };
      const results = await this.provider.search(args.query, opts);
      const builder = new ToolResultBuilder({ maxLineLength: null });

      if (results.length === 0) {
        builder.write('No search results found.');
        return builder.ok();
      }

      let first = true;
      for (const result of results) {
        if (!first) builder.write('---\n\n');
        first = false;

        builder.write(`Title: ${result.title}\n`);
        if (result.siteName) builder.write(`Site: ${result.siteName}\n`);
        if (result.date) builder.write(`Date: ${result.date}\n`);
        builder.write(`URL: ${result.url}\n`);
        builder.write(`Snippet: ${result.snippet}\n\n`);
      }

      // Keep the citation reminder next to the data (not just in the static tool
      // description), so it is present on every search. Cite the page actually
      // relied on — after a FetchURL follow-up, that is the fetched page.
      builder.write(
        'When you rely on a result in your answer, cite it inline as a markdown link, e.g. [title](url).',
      );

      return builder.ok();
    } catch (error) {
      return {
        isError: true,
        output: classifySearchError(error),
      };
    }
  }

}

// ── Error classification ─────────────────────────────────────────────

/**
 * Maps a thrown search error to a categorised, human-readable message.
 *
 * The original error text is always preserved so the model can still see the
 * underlying detail; the prefix only adds a category so failures are easier to
 * reason about (e.g. retry vs. surface to the user).
 */
function classifySearchError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (name === 'AbortError' || lower.includes('abort')) {
    return `Search cancelled: ${message}`;
  }
  if (name === 'TimeoutError' || lower.includes('timed out') || lower.includes('timeout')) {
    return `Search timed out: ${message}`;
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return `Search failed (authentication): ${message}`;
  }
  if (
    lower.includes('http ') ||
    lower.includes('network') ||
    lower.includes('fetch') ||
    name === 'TypeError'
  ) {
    return `Search failed (network): ${message}`;
  }
  return `Search failed: ${message}`;
}
