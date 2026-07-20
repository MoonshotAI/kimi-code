/**
 * `auth` domain (cross-cutting) — `WebSearch` builtin tool and its
 * `WebSearchProvider` contract.
 *
 * Defines the `WebSearch` tool and the host-injected `WebSearchProvider`
 * interface (plus `WebSearchResult`). Web search needs an authenticated
 * Moonshot backend, so the tool lives in the KimiOAuth `auth` domain: it reads
 * its provider from the App-scope `IWebSearchProviderService` at
 * registry-construction time and self-registers via `registerTool(...)` at
 * module load, but only when a provider is configured (there is no local
 * search backend).
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type BuiltinTool,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { ToolResultBuilder } from '#/tool/result-builder';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IWebSearchProviderService } from '../webSearch';
import DESCRIPTION from './web-search.md?raw';


export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  siteName?: string;
}

export interface WebSearchProvider {
  search(
    query: string,
    options?: {
      toolCallId?: string;
      signal?: AbortSignal;
    },
  ): Promise<WebSearchResult[]>;
}


export const WebSearchInputSchema = z.object({
  query: z.string().describe('The query text to search for.'),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;


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
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const results = await this.provider.search(args.query, { toolCallId, signal });
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

      builder.write(
        'When you rely on a result in your answer, cite it inline as a markdown link, e.g. [title](url).',
      );

      return builder.ok();
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        isError: true,
        output: classifySearchError(error),
      };
    }
  }
}


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

registerTool(WebSearchTool, {
  when: (accessor) => accessor.get(IWebSearchProviderService).getWebSearchProvider() !== undefined,
  staticArgs: (accessor) => {
    const provider = accessor.get(IWebSearchProviderService).getWebSearchProvider();
    if (provider === undefined) {
      throw new Error('WebSearchProviderService returned no provider during tool registration.');
    }
    return [provider];
  },
});
