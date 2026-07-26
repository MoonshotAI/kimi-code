/**
 * `web` domain (L4) — `FetchURL` builtin tool.
 *
 * Defines the `FetchURL` tool. The host-injected `UrlFetcher` contract lives
 * in `fetch-url-types`; the tool receives the App-scope `IWebFetchService`
 * via DI and self-registers via `registerAgentTool(...)` at module load. The
 * default service falls back to the
 * built-in `LocalFetchURLProvider`, so `FetchURL` is always available without OAuth.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  type AgentTool,
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { ToolResultBuilder } from '#/tool/result-builder';
import { registerAgentTool } from '#/agent/toolRegistry/toolContribution';

import { IWebFetchService } from '../web';
import { HttpFetchError, type UrlFetcher } from './fetch-url-types';
import DESCRIPTION from './fetch-url.md?raw';


export const FetchURLInputSchema = z.object({
  url: z.string().describe('The URL to fetch content from.'),
});

export type FetchURLInput = z.infer<typeof FetchURLInputSchema>;


export interface IFetchURLTool extends AgentTool<FetchURLInput> {
  readonly _serviceBrand: undefined;
}
export const IFetchURLTool = createDecorator<IFetchURLTool>('fetchURLTool');

export class FetchURLTool implements IFetchURLTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'FetchURL' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FetchURLInputSchema);

  private readonly fetcher: UrlFetcher;

  constructor(@IWebFetchService webFetch: IWebFetchService) {
    this.fetcher = webFetch.getUrlFetcher();
  }

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
      const { content, kind } = await this.fetcher.fetch(args.url, { toolCallId, signal });

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

registerAgentTool(IFetchURLTool, FetchURLTool, { name: 'FetchURL', domain: 'web' });
