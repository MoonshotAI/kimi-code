import type { ToolInputDisplay } from '@moonshot-ai/agent-core-v2/tool/toolInputDisplay';
import type { ContentPart, HistoryMessage, PromptOrigin } from '@moonshot-ai/agent-core-v2';

import type { BackgroundTaskStatus } from '#/task';

export type { PromptOrigin };

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface BackgroundTaskOrigin {
  readonly kind: 'background_task';
  readonly taskId: string;
  readonly status: BackgroundTaskStatus;
  readonly notificationId: string;
}

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

export type { ToolInputDisplay };
