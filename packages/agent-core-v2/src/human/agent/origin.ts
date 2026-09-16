import type { ContentPart } from '#/llm/message';

import type { AgentTaskStatus } from './taskStatus';

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface PromptFileAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly path: string;
}

export interface BundledSkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export interface UserPromptOrigin {
  readonly kind: 'user';
  readonly skillActivations?: readonly BundledSkillActivation[];
  readonly attachments?: readonly PromptFileAttachment[];
}

export const USER_PROMPT_ORIGIN: UserPromptOrigin = { kind: 'user' };

export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
  readonly attachments?: readonly PromptFileAttachment[];
}

export interface PluginCommandOrigin {
  readonly kind: 'plugin_command';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string;
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

export interface SteerMessage {
  readonly content: readonly ContentPart[];
  readonly origin?: PromptOrigin;
}

function userOriginOf(origin: PromptOrigin | undefined): UserPromptOrigin | undefined {
  return origin !== undefined && origin.kind === 'user' ? origin : undefined;
}

function bundledSkillBlockCount(message: SteerMessage): number {
  return userOriginOf(message.origin)?.skillActivations?.length ?? 0;
}

export function stripBundledSkillBlocks(message: SteerMessage): ContentPart[] {
  return message.content.slice(bundledSkillBlockCount(message));
}

export function mergeSteerMessages(messages: readonly SteerMessage[]): {
  role: 'user';
  content: ContentPart[];
  origin: UserPromptOrigin;
} {
  const skillActivations = messages.flatMap(
    (message) => userOriginOf(message.origin)?.skillActivations ?? [],
  );
  const attachments = messages.flatMap((message) => userOriginOf(message.origin)?.attachments ?? []);
  return {
    role: 'user',
    content: [
      ...messages.flatMap((message) => message.content.slice(0, bundledSkillBlockCount(message))),
      ...messages.flatMap((message) => stripBundledSkillBlocks(message)),
    ],
    origin:
      skillActivations.length === 0 && attachments.length === 0
        ? USER_PROMPT_ORIGIN
        : {
            kind: 'user',
            skillActivations: skillActivations.length === 0 ? undefined : skillActivations,
            attachments: attachments.length === 0 ? undefined : attachments,
          },
  };
}
