/**
 * `tools` domain — `WebSearchTool` implementation (the `WebSearch` tool).
 *
 * Resolves the host-injected `WebSearchProvider` from the App-scope
 * `IWebSearchProviderService` (`auth` domain) per invocation — the activation
 * gate checks presence alone, and the provider (which embeds the frozen
 * identity headers) only composes once a call needs it, so tool construction
 * during a fast bootstrap cannot race the identity freeze and a mid-session
 * login or config edit reaches the next call. The tool only activates when a
 * provider is configured, because there is no local search backend; results
 * render through `ToolResultBuilder`, and provider errors classify into
 * model-readable output.
 *
 * Registered via the module-level `registerAgentToolService(IWebSearchTool,
 * WebSearchTool)` at the bottom of this file — the same "import = register"
 * pattern used by every agent tool. Bound at Agent scope.
 */

import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { ToolResultBuilder } from '#/tool/result-builder';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IWebSearchProviderService } from '#/app/auth/webSearch/webSearch';

import {
  IWebSearchTool,
  WebSearchInputSchema,
  type WebSearchInput,
} from './web-search';
import DESCRIPTION from './web-search.md?raw';


export class WebSearchTool implements IWebSearchTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'WebSearch' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WebSearchInputSchema);

  constructor(
    @IWebSearchProviderService private readonly providerService: IWebSearchProviderService,
  ) {}

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
    const provider = this.providerService.getWebSearchProvider();
    if (provider === undefined) {
      return {
        isError: true,
        output: 'Web search is no longer configured; the provider was removed after this session started.',
      };
    }
    try {
      const results = await provider.search(args.query, { toolCallId, signal });
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

registerAgentToolService(IWebSearchTool, WebSearchTool, {
  name: 'WebSearch',
  domain: 'auth',
  when: (accessor) => accessor.get(IWebSearchProviderService).hasWebSearchProvider(),
});
