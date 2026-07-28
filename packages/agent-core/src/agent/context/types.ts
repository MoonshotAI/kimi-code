import type { ContentPart, Message } from '@moonshot-ai/kosong';

import type { SkillSource } from '../../skill';
import type { ToolInputDisplay } from '../../tools/display';
import type { BackgroundTaskStatus } from '../background';

export interface UserPromptOrigin {
  readonly kind: 'user';
}

export const USER_PROMPT_ORIGIN: UserPromptOrigin = { kind: 'user' };

export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string | undefined;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillType?: string | undefined;
  readonly skillPath?: string | undefined;
  readonly skillSource?: SkillSource | undefined;
}

export interface PluginCommandOrigin {
  readonly kind: 'plugin_command';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string | undefined;
  readonly trigger: 'user-slash';
}

export interface InjectionOrigin {
  readonly kind: 'injection';
  readonly variant: string;
}

export interface ShellCommandOrigin {
  readonly kind: 'shell_command';
  readonly phase: 'input' | 'output';
  /** Only present on `phase: 'output'` — whether the command failed, so replay
   *  can colour stderr red only for actual failures (not warnings). */
  readonly isError?: boolean;
}

export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  readonly name: string;
}

export interface BackgroundTaskOrigin {
  readonly kind: 'background_task';
  readonly taskId: string;
  readonly status: BackgroundTaskStatus;
  readonly notificationId: string;
}

export interface CronJobOrigin {
  readonly kind: 'cron_job';
  readonly jobId: string;
  readonly cron: string;
  readonly recurring: boolean;
  /** Number of theoretical fires that were collapsed into this single delivery (>= 1). */
  readonly coalescedCount: number;
  /** True for recurring tasks past the 7-day age threshold. */
  readonly stale: boolean;
}

export interface CronMissedOrigin {
  readonly kind: 'cron_missed';
  /** Number of one-shot tasks bundled into this missed-fire notification. */
  readonly count: number;
}

export interface HookResultOrigin {
  readonly kind: 'hook_result';
  readonly event: string;
  readonly blocked?: boolean;
}

export interface RetryOrigin {
  readonly kind: 'retry';
  readonly trigger?: string;
}

export type PromptOrigin =
  | UserPromptOrigin
  | SkillActivationOrigin
  | PluginCommandOrigin
  | InjectionOrigin
  | ShellCommandOrigin
  | CompactionSummaryOrigin
  | SystemTriggerOrigin
  | BackgroundTaskOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin;

export type ContextMessage = Message & {
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
  /**
   * UI-only input displays keyed by tool call id. These are rebuilt from the
   * persisted loop events for resume/replay and stripped before provider calls.
   */
  toolCallDisplays?: Record<string, ToolInputDisplay>;
  /**
   * Tool-result side channel rendered to the model but never to UIs; see
   * `ExecutableToolResult.note`. Appended to the projected tool message at
   * the provider boundary and stripped from the wire message itself.
   */
  readonly note?: string;
};

export interface UserMessageRecord {
  content: readonly ContentPart[];
  origin: PromptOrigin;
}

export interface SystemReminderRecord {
  content: string;
  origin: PromptOrigin;
}

export interface AgentContextData {
  history: readonly ContextMessage[];
  tokenCount: number;
}

/**
 * Estimated per-category token cost of the agent's context, behind the
 * `/context` report. All values except `contextTokens` are character-heuristic
 * estimates (see `estimateTokens`); the real numbers only exist per LLM
 * round-trip and are not attributed per category.
 */
export interface ContextBreakdownData {
  /**
   * Last known total context tokens (same source as the status bar): the most
   * recent LLM-reported usage, which covers system prompt + tool schemas +
   * messages + the last turn's output. 0 before the first LLM round-trip.
   */
  contextTokens: number;
  /**
   * Effective used tokens for the report header and free-space calculation:
   * `max(contextTokens, estimated category sum)`. Before the first LLM
   * round-trip `contextTokens` is still 0 while the system-prompt/tool
   * overhead is real, so the raw total would contradict the per-category
   * rows (non-zero categories against "100% free"); the effective value
   * keeps the panel self-consistent in both states.
   */
  usedTokens: number;
  /** Model context-window size in tokens; 0 when unknown. */
  maxContextTokens: number;
  /**
   * Estimated tokens of the base system prompt — the rendered template minus
   * the injected memory (AGENTS.md) and skill-listing sections.
   */
  systemPrompt: number;
  /** Estimated schema tokens of the builtin + user tools currently exposed. */
  systemTools: number;
  /** Estimated schema tokens of the MCP tools currently exposed inline. */
  mcpTools: number;
  /** Per-server split of `mcpTools` (only servers with exposed tools appear). */
  mcpServers: readonly ContextBreakdownMcpServer[];
  /** Estimated tokens of the injected AGENTS.md memory content. */
  memoryFiles: number;
  /** Per-file split of `memoryFiles`. */
  memoryFileEntries: readonly ContextBreakdownMemoryFile[];
  /** Estimated tokens of the skill listing injected into the system prompt. */
  skills: number;
  /**
   * Per-skill split of the model skill listing. Covers exactly the skills the
   * model listing carries (invocable, non-sub-skills) — a subset of what
   * `/skills` lists. Per-skill values exclude the listing's header and group
   * labels, so they sum to slightly less than `skills`.
   */
  skillEntries: readonly ContextBreakdownSkill[];
  /**
   * Remainder attributed to the conversation: `usedTokens` minus every
   * estimated category above. Because the LLM-reported total covers system
   * prompt + tool schemas + the last turn's output, this residual also
   * absorbs the output tokens and any estimation error of the other
   * categories. It is 0 before the first LLM round-trip.
   */
  messages: number;
}

export interface ContextBreakdownMcpServer {
  readonly name: string;
  readonly tokens: number;
}

export interface ContextBreakdownMemoryFile {
  readonly path: string;
  readonly tokens: number;
}

export interface ContextBreakdownSkill {
  readonly name: string;
  readonly source: SkillSource;
  readonly tokens: number;
}
