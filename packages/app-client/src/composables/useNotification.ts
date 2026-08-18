// packages/app-client/src/composables/useNotification.ts
// Pure notification helpers: the should-notify predicate, the per-kind copy
// builders (translator-injected), and the ctx types. The notification
// preferences and the maybeNotify* actions live in the notifications Pinia
// store (stores/notifications.ts) since P9 — this module stays pure (no state,
// no Notification API, no track).

import type { Translator } from '@moonshot-ai/app-core/contracts';

export function shouldNotifyCompletion(
  status: 'idle' | 'aborted',
  hasPendingApproval: boolean,
  hasPendingQuestion: boolean,
): boolean {
  return status === 'idle' && !hasPendingApproval && !hasPendingQuestion;
}

export interface NotifyBaseCtx {
  /** True when the user is actually watching the target session: it is the
      active session, the page is visible, and the window has focus — in which
      case we suppress the notification. */
  isUserWatching: boolean;
  /** Session title used as the completion notification body and a question-body fallback. */
  sessionTitle: string;
  /** Called when the user clicks the notification (e.g. select the session). */
  onClick: () => void;
}

export interface NotifyCompletionCtx extends NotifyBaseCtx {
  /** Prompt id of the finished turn; keys the dedup tag so every turn fires its
      own notification while a replayed idle event for the same turn stays
      collapsed. Falls back to a per-call unique tag when absent. */
  promptId?: string;
}

export interface NotifyQuestionCtx extends NotifyBaseCtx {
  /** Short preview of the question, used as the notification body. Falls back
      to the session title, then to a generic line when empty. */
  questionPreview: string;
  /** Unique question request id; used to deduplicate notifications per request. */
  questionId: string;
}

export interface NotifyApprovalCtx extends NotifyBaseCtx {
  /** Tool call name needing approval, used as the notification body. */
  toolName: string;
  /** Unique approval request id; used to deduplicate notifications per request. */
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
