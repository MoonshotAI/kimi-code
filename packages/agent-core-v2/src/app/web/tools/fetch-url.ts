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

import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/_base/tools/support/rule-match';
import { ToolAccesses } from '#/agent/tool/tool-access';
import type {
  BuiltinTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/agent/tool/toolContract';
import { ToolResultBuilder } from '#/agent/tool/result-builder';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IWebFetchService } from '../web';
import { HttpFetchError, type UrlFetcher } from './fetch-url-types';
import DESCRIPTION from './fetch-url.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

export const FetchURLInputSchema = z.object({
  url: z.string().describe('The URL to fetch content from.'),
});

export type FetchURLInput = z.infer<typeof FetchURLInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

export class FetchURLTool implements BuiltinTool<FetchURLInput> {
  readonly name = 'FetchURL' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(FetchURLInputSchema);

  constructor(private readonly fetcher: UrlFetcher) {}

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
      builder.write(content);
      // Tell the LLM whether it received the whole body or only the
      // extracted article text, so it can judge how complete the
      // content is.
      const message =
        kind === 'passthrough'
          ? 'The returned content is the full response body, returned verbatim.'
          : 'The returned content is the main text extracted from the page.';
      return builder.ok(message);
    } catch (error) {
      // An in-flight abort rejects the signal-aware fetch promptly. Re-throw
      // so the executor can classify it (including user cancellation) and
      // produce the right message, rather than surfacing it as a generic
      // network error that the model may retry.
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

registerTool(FetchURLTool, {
  staticArgs: (accessor) => [accessor.get(IWebFetchService).getUrlFetcher()],
});
