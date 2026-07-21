/**
 * `web` domain (L4) — `FetchURL` builtin tool.
 *
 * Defines the `FetchURL` tool. The host-injected `UrlFetcher` contract lives
 * in `fetch-url-types`; the tool reads its fetcher from the App-scope
 * `IWebFetchService` at registry-construction time and self-registers via
 * `registerTool(...)` at module load. The default service falls back to the
 * built-in `LocalFetchURLProvider`, so `FetchURL` is always available without OAuth.
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

import { IWebFetchService } from '../web';
import { HttpFetchError, type UrlFetcher } from './fetch-url-types';
import { t } from '@moonshot-ai/kimi-i18n';
import DESCRIPTION from './fetch-url.md?raw';


export const FetchURLInputSchema = z.object({
  url: z.string().describe('The URL to fetch content from.'),
});

export type FetchURLInput = z.infer<typeof FetchURLInputSchema>;


export class FetchURLTool implements BuiltinTool<FetchURLInput> {
  readonly name = 'FetchURL' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FetchURLInputSchema);

  constructor(private readonly fetcher: UrlFetcher) {}

  resolveExecution(args: FetchURLInput): ToolExecution {
    const preview = args.url.length > 50 ? `${args.url.slice(0, 50)}…` : args.url;
    return {
      accesses: ToolAccesses.none(),
      description: t('toolsV2.fetchUrl.fetching', { preview: preview }),
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
          output: t('toolsV2.fetchUrl.emptyBody'),
          isError: false,
        };
      }

      const builder = new ToolResultBuilder({ maxLineLength: null });
      const note =
        kind === 'passthrough'
          ? t('toolsV2.fetchUrl.passthroughNote')
          : t('toolsV2.fetchUrl.extractedNote');
      const citeReminder = t('toolsV2.fetchUrl.citeReminder');
      builder.write(`${note} ${citeReminder}\n\n${content}`);
      return builder.ok();
    } catch (error) {
      if (signal.aborted) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof HttpFetchError) {
        return {
          isError: true,
          output: t('toolsV2.fetchUrl.failedHttp', { status: String(error.status), message: msg }),
        };
      }
      return {
        isError: true,
        output: t('toolsV2.fetchUrl.networkError', { url: args.url, message: msg }),
      };
    }
  }
}

registerTool(FetchURLTool, {
  staticArgs: (accessor) => [accessor.get(IWebFetchService).getUrlFetcher()],
});
