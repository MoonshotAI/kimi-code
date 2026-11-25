
import type { Translator } from '@moonshot-ai/app-core/contracts';
import type { ConversationContinuation } from '@moonshot-ai/app-core/conversation';

export function shouldNotifyCompletion(
  status: 'idle' | 'aborted',
  hasPendingApproval: boolean,
  hasPendingQuestion: boolean,
  continuation?: ConversationContinuation,
): boolean {
  if (continuation !== undefined && continuation !== 'none') return false;
  return status === 'idle' && !hasPendingApproval && !hasPendingQuestion;
}

export interface NotifyBaseCtx {
  isUserWatching: boolean;
  sessionTitle: string;
  onClick: () => void;
}

export interface NotifyCompletionCtx extends NotifyBaseCtx {
  promptId?: string;
}

export interface NotifyQuestionCtx extends NotifyBaseCtx {
  questionPreview: string;
  questionId: string;
}

export interface NotifyApprovalCtx extends NotifyBaseCtx {
  toolName: string;
  approvalId: string;
}

export interface NotificationCopy {
  readonly title: string;
  readonly body: string;
}

function firstText(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function completionNotificationCopy(t: Translator, sessionTitle: string): NotificationCopy {
  return {
    title: t('settings.notifyTitle'),
    body: firstText(sessionTitle, t('settings.notifyFallback')),
  };
}

export function questionNotificationCopy(
  t: Translator,
  sessionTitle: string,
  questionPreview: string,
): NotificationCopy {
  return {
    title: t('settings.notifyQuestionTitle'),
    body: firstText(
      questionPreview,
      sessionTitle,
      t('settings.notifyQuestionFallback'),
    ),
  };
}

export function approvalNotificationCopy(
  t: Translator,
  sessionTitle: string,
  toolName: string,
): NotificationCopy {
  return {
    title: t('settings.notifyApprovalTitle'),
    body: firstText(
      toolName,
      sessionTitle,
      t('settings.notifyApprovalFallback'),
    ),
  };
}
