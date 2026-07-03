/**
 * FetchURLTool — host-injected URL fetcher.
 *
 * kimi-core defines the interface; the host provides the real fetch
 * implementation via `UrlFetcher`. If no fetcher is supplied, the tool
 * should not be registered (not exposed to the LLM).
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '../../support/rule-match';
import { ToolResultBuilder } from '../../support/result-builder';
import DESCRIPTION from './fetch-url.md?raw';

// ── Provider interface (host-injected) ───────────────────────────────

/**
 * How the returned content relates to the original response body.
 *
 * - `passthrough` — the body was already plain text / markdown and is
 *   returned verbatim, in full.
 * - `extracted` — the body was an HTML page; only the main article text
 *   was extracted and returned.
 */
export type UrlFetchKind = 'passthrough' | 'extracted';

export interface UrlFetchResult {
  /** The text handed to the LLM. */
  content: string;
  /** Whether `content` is a verbatim passthrough or extracted main text. */
  kind: UrlFetchKind;
}

export interface UrlFetcher {
  fetch(url: string, options?: { toolCallId?: string }): Promise<UrlFetchResult>;
}

/**
 * Thrown by a `UrlFetcher` when the upstream HTTP request completed but
 * returned a non-success status. The tool branches on this to surface
 * `Status: N` in the error message; non-HTTP failures (DNS, timeout,
 * connection reset, …) keep flowing through as plain `Error`.
 */
export class HttpFetchError extends Error {
  override readonly name = 'HttpFetchError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ── Input schema ─────────────────────────────────────────────────────

export const FetchURLInputSchema = z.object({
  url: z.string().describe('The URL to fetch content from.'),
});

export type FetchURLInput = z.Infer<typeof FetchURLInputSchema>;

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
    {
    toolCallId,
    }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const { content, kind } = await this.fetcher.fetch(args.url, { toolCallId });

      if (!content) {
        return {
          output: 'The response body is empty.',
          isError: false,
        };
      }

      const builder = new ToolResultBuilder({ maxLineLength: null });
      // Tell the LLM whether it received the whole body or only the extracted
      // article text, so it can judge how complete the content is, and remind it
      // to cite this page when it uses the content. Both notes must ride in
      // `output`: the result's `message` field is dropped from the transcript, so
      // `output` is the only place the model can read them. Put them at the front
      // so they survive any downstream truncation of the body.
      const note =
        kind === 'passthrough'
          ? 'The returned content is the full response body, returned verbatim.'
          : 'The returned content is the main text extracted from the page.';
      const citeReminder =
        'If you use it in your answer, cite this page as a markdown link, e.g. [title](url).';
      builder.write(`${note} ${citeReminder}\n\n${content}`);
      return builder.ok();
    } catch (error) {
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
