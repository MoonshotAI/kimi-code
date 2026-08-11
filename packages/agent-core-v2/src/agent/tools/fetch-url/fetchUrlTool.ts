/**
 * `tools` domain — `FetchURLTool` implementation.
 *
 * Receives the App-scope `IWebFetchService` via DI and resolves its
 * host-injected `UrlFetcher` per invocation — the service re-reads config and
 * login state on each `getUrlFetcher()` call, and composing the fetcher at
 * tool construction would both pin that state for the agent's lifetime and
 * race the identity freeze during a fast bootstrap. The default service falls
 * back to the built-in `LocalFetchURLProvider`, so `FetchURL` is always
 * available without OAuth. Bound at Agent scope; self-registers via
 * `registerAgentToolService(...)` at module load.
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

import { IWebFetchService } from '#/app/web/web';
import { HttpFetchError } from '#/app/web/tools/fetch-url-types';
import { FetchURLInputSchema, IFetchURLTool, type FetchURLInput } from './fetch-url';
import DESCRIPTION from './fetch-url.md?raw';

export class FetchURLTool implements IFetchURLTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'FetchURL' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FetchURLInputSchema);

  constructor(@IWebFetchService private readonly webFetch: IWebFetchService) {}

  resolveExecution(args: FetchURLInput): ToolExecution {
    const preview = args.url.length > 50 ? `${args.url.slice(0, 50)}…` : args.url;
    return {
      accesses: ToolAccesses.none(),
      description: `Fetching: ${preview}`,
      display: { kind: 'url_fetch', url: args.url },
      approvalRule: literalRulePattern(this.name, args.url),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.url),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: FetchURLInput,
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const { content, kind } = await this.webFetch
        .getUrlFetcher()
        .fetch(args.url, { toolCallId, signal });

      if (!content) {
        return {
          output: 'The response body is empty.',
          isError: false,
        };
      }

      const builder = new ToolResultBuilder({ maxLineLength: null });
      const note =
        kind === 'passthrough'
          ? 'The returned content is the full response body, returned verbatim.'
          : 'The returned content is the main text extracted from the page.';
      const citeReminder =
        'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).';
      builder.write(`${note} ${citeReminder}\n\n${content}`);
      return builder.ok();
    } catch (error) {
      if (signal.aborted) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof HttpFetchError) {
        return {
          isError: true,
          output: `Failed to fetch URL. Status: ${String(error.status)}. ${msg}`,
        };
      }
      return {
        isError: true,
        output: `Failed to fetch URL due to network error: ${args.url}. ${msg}`,
      };
    }
  }
}

registerAgentToolService(IFetchURLTool, FetchURLTool, { name: 'FetchURL', domain: 'web' });
