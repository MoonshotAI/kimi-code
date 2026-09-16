import type { ContentPart } from '#human/llm/message';
import type { HistoryMessage } from '#human/agent/turn';
import type { PromptOrigin } from '#human/agent/origin';

export type { AgentTaskStatus } from '#human/agent/taskStatus';
export type {
  BundledSkillActivation,
  CronJobOrigin,
  CronMissedOrigin,
  HookResultOrigin,
  InjectionOrigin,
  PluginCommandOrigin,
  PromptFileAttachment,
  PromptOrigin,
  RetryOrigin,
  ShellCommandOrigin,
  SkillActivationOrigin,
  SkillSource,
  CompactionSummaryOrigin,
  SystemTriggerOrigin,
  TaskOrigin,
  UserPromptOrigin,
} from '#human/agent/origin';
export { USER_PROMPT_ORIGIN } from '#human/agent/origin';

export interface UserMessageRecord {
  content: readonly ContentPart[];
  origin: PromptOrigin;
}

export interface SystemReminderRecord {
  content: string;
  origin: PromptOrigin;
}

export interface AgentContextData {
  history: readonly HistoryMessage[];
  tokenCount: number;
}
