/**
 * `contextMemory` shared contract types — message origins, `AgentContextData`,
 * and the `ContextModel` fold state.
 *
 * `ContextState` is the `ContextModel` state: the folded messages plus the
 * fold cursor (`ContextFoldState` — the reduction position of the loop-event
 * fold across records: `pending` holds toolCallIds with no result yet,
 * `deferred` holds entries appended while a tool exchange is still open,
 * flushed once it closes to preserve assistant↔tool adjacency). The cursor
 * lives in the state (not beside it) so every wholesale replacement — undo,
 * clear, compaction — resets it structurally by returning `EMPTY_FOLD`.
 * Plain data: arrays instead of Sets keep the state freeze- and JSON-safe.
 * Generic over the entry type: the wire model folds `ContextMessage`s, while
 * the display transcript folds time-stamped entries through the same kernel.
 *
 * `messages` is an APPEND-ONLY log: `context.apply_compaction` settles any
 * open frame in place and then appends a summary marker message carrying a
 * `CompactionMeta` instead of replacing the history, so pre-compaction
 * messages stay in the state and no `partial` frame ever survives a marker.
 * The model-visible window is a read-time derivation
 * (`visibleWindow.deriveVisibleMessages`) over this log — only undo / clear /
 * the swarm-mode pop still cut it.
 *
 * `freezeContextState` deeply freezes a `ContextState` (the wire service only
 * shallow-freezes the top-level object, which covered the consumer view back
 * when the state WAS the messages array). `Object.freeze` returns the same
 * reference, so the wire's reference-equality gate is unaffected.
 */

import type { ContentPart, Message } from '#/kosong/contract/message';

import type { AgentTaskStatus } from '#/agent/task/task';

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface UserPromptOrigin {
  readonly kind: 'user';
  readonly skillActivations?: readonly BundledSkillActivation[];
}

export const USER_PROMPT_ORIGIN: UserPromptOrigin = { kind: 'user' };

export interface BundledSkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

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
  readonly ownerPromptId?: string;
  readonly disclosure?: unknown;
}

export interface ShellCommandOrigin {
  readonly kind: 'shell_command';
  readonly phase: 'input' | 'output';
  readonly isError?: boolean;
}

export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  readonly name: string;
}

export interface TaskOrigin {
  readonly kind: 'task';
  readonly taskId: string;
  readonly status: AgentTaskStatus;
  readonly notificationId: string;
}

export interface CronJobOrigin {
  readonly kind: 'cron_job';
  readonly jobId: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly coalescedCount: number;
  readonly stale: boolean;
}

export interface CronMissedOrigin {
  readonly kind: 'cron_missed';
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
  | TaskOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin;

/**
 * Marker metadata the `context.apply_compaction` fold attaches to the summary
 * message it appends — the persisted record fields mirrored onto the message
 * so the append-only log stays self-describing. `visibleWindow` finds markers
 * by this field; the derivation itself needs only `legacyTail` +
 * `compactedCount`, the rest is informational (telemetry / debugging). Never
 * persisted inside an `append_message` record — the fold strips it from
 * appended messages (see `foldAppendMessage`).
 */
export interface CompactionMeta {
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter?: number;
  readonly summaryOutputTokens?: number;
  readonly keptUserMessageCount?: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
  readonly legacyTail?: boolean;
}

export type ContextMessage = Message & {
  readonly id?: string;
  readonly providerMessageId?: string;
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
  readonly note?: string;
  readonly compaction?: CompactionMeta;
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

export interface ContextFoldState<E = ContextMessage> {
  readonly openStepUuid?: string;
  readonly pending: readonly string[];
  readonly deferred: readonly E[];
}

export const EMPTY_FOLD: ContextFoldState<never> = Object.freeze({
  pending: Object.freeze([]),
  deferred: Object.freeze([]),
});

export interface ContextState<E = ContextMessage> {
  readonly messages: readonly E[];
  readonly fold: ContextFoldState<E>;
}

export function freezeContextState(state: ContextState): ContextState {
  const { fold } = state;
  Object.freeze(fold.pending);
  Object.freeze(fold.deferred);
  Object.freeze(fold);
  Object.freeze(state.messages);
  return Object.freeze(state);
}
