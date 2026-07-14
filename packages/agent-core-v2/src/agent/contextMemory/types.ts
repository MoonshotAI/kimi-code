import type { ContentPart, Message } from '#/app/llmProtocol/message';

import type { AgentTaskStatus } from '#/agent/task/task';
import type { CronJobOrigin, CronMissedOrigin, ShellCommandOrigin } from '@moonshot-ai/protocol';

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

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

export type ContextMessage = Message & {
  readonly id?: string;
  readonly providerMessageId?: string;
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
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
