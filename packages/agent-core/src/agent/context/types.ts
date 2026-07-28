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
 * `/context` report. All values except `contextTokens`/`messages` are
 * character-heuristic estimates (see `estimateTokens`); the real numbers
 * only exist per LLM round-trip and are not attributed per category.
 */
export interface ContextBreakdownData {
  /** Last known total context tokens (same source as the status bar). */
  contextTokens: number;
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
  /** Estimated tokens of the injected AGENTS.md memory content. */
  memoryFiles: number;
  /** Estimated tokens of the skill listing injected into the system prompt. */
  skills: number;
  /** Tokens of the conversation history (same as `contextTokens`). */
  messages: number;
}
