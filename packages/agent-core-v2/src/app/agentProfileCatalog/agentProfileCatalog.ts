import type { ILogger } from '#/_base/log/log';
import type { IHostProcessService } from '#/os/interface/hostProcess';

export const DEFAULT_AGENT_PROFILE_NAME = 'agent';

export interface AgentProfilePromptPrefixContext {
  readonly cwd: string;
  readonly process: IHostProcessService;
  readonly log?: ILogger;
}

export interface AgentProfileSummaryPolicy {
  readonly minChars: number;
  readonly continuationPrompt: string;
  readonly retries: number;
}

export interface AgentProfileContext {
  readonly cwd?: string;
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly additionalDirsInfo?: string;
  readonly osKind?: string;
  readonly shellName?: string;
  readonly shellPath?: string;
  readonly now?: string;
  readonly timeZone?: string;
  readonly skills?: string;
  readonly skillActive?: boolean;
  readonly pluginSections?: string;
  readonly productName?: string;
  readonly replyStyleGuide?: string;
  readonly [key: string]: unknown;
}

export interface EnvironmentDisclosureSnapshot {
  readonly cwd: string;
  readonly date:
    | { readonly disclosed: true; readonly value: { readonly localDate: string; readonly timeZone: string } }
    | { readonly disclosed: false };
}

export interface SystemPromptRenderResult {
  readonly text: string;
  readonly environment: EnvironmentDisclosureSnapshot;
}

export interface AgentProfile {
  readonly name: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly override?: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly systemPrompt: (context: AgentProfileContext) => string;
  readonly renderSystemPrompt: (context: AgentProfileContext) => SystemPromptRenderResult;
  readonly promptPrefix?: (ctx: AgentProfilePromptPrefixContext) => Promise<string>;
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
}

/**
 * The profile shape accepted at registration ({@link registerAgentProfile},
 * file-based profile factories): authors provide at least one render entry —
 * the structured `renderSystemPrompt`, the legacy text-only `systemPrompt`,
 * or both (the structured renderer is then authoritative). The union
 * statically requires at least one entry; {@link normalizeAgentProfile} still
 * throws on inputs that escaped the type check (plain JS, casts).
 * {@link normalizeAgentProfile} derives the other method, so a registered
 * {@link AgentProfile} always carries both and its `systemPrompt` text always
 * comes from the same render as its disclosure metadata. A text-only input
 * renders with no disclosed environment facts. Callbacks are bound to the
 * input object at runtime, so method-style definitions relying on `this`
 * keep working.
 */
export type AgentProfileInput = Omit<AgentProfile, 'systemPrompt' | 'renderSystemPrompt'> &
  (
    | {
        readonly systemPrompt: (context: AgentProfileContext) => string;
        readonly renderSystemPrompt?: (
          context: AgentProfileContext,
        ) => SystemPromptRenderResult;
      }
    | {
        readonly systemPrompt?: (context: AgentProfileContext) => string;
        readonly renderSystemPrompt: (context: AgentProfileContext) => SystemPromptRenderResult;
      }
  );

export function normalizeAgentProfile(input: AgentProfileInput): AgentProfile {
  if (input.renderSystemPrompt !== undefined) {
    const render = input.renderSystemPrompt.bind(input);
    return {
      ...input,
      renderSystemPrompt: render,
      systemPrompt: (context) => render(context).text,
    };
  }
  if (input.systemPrompt !== undefined) {
    const systemPrompt = input.systemPrompt.bind(input);
    return {
      ...input,
      systemPrompt,
      renderSystemPrompt: (context) => ({
        text: systemPrompt(context),
        environment: { cwd: context.cwd ?? '', date: { disclosed: false } },
      }),
    };
  }
  throw new Error(
    `Agent profile "${input.name}" must define systemPrompt or renderSystemPrompt.`,
  );
}
