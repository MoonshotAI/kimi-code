// apps/kimi-web/src/composables/client/useNotification.ts
// Browser notifications for when the agent needs attention: a turn finished, a
// question waiting for an answer, or a tool needing approval. Each kind has its
// own on/off preference (persisted) plus the shared OS permission + Notification
// API. Pure UI action module — it never reads rawState or calls the API. The
// rawState-dependent bits (is the user watching the session, its title, the
// click-to-select action) are passed in by the caller via the ctx objects.
//
// Why three preferences: completion notifications default on (existing
// behavior), but question and approval notifications surface request text/tool
// names and default OFF, so an existing user who only opted into completion
// alerts doesn't start receiving sensitive content on their desktop without
// explicitly opting in.

import { ref, type Ref } from 'vue';
import { i18n } from '../../i18n';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../../lib/storage';

export function shouldNotifyCompletion(
  status: 'idle' | 'aborted',
  hasPendingApproval: boolean,
  hasPendingQuestion: boolean,
): boolean {
  return status === 'idle' && !hasPendingApproval && !hasPendingQuestion;
}

function loadNotify(key: string, defaultOn: boolean): boolean {
  const v = safeGetString(key);
  return v === null ? defaultOn : v === '1';
}

const notifyOnComplete = ref(loadNotify(STORAGE_KEYS.notifyOnComplete, true));
const notifyOnQuestion = ref(loadNotify(STORAGE_KEYS.notifyOnQuestion, false));
const notifyOnApproval = ref(loadNotify(STORAGE_KEYS.notifyOnApproval, false));
const notifyPermission = ref<string>(
  typeof Notification !== 'undefined' ? Notification.permission : 'denied',
);

const NOTIFICATION_ICON = '/favicon.ico';

/** Shared setter: disabling is instant; enabling requests OS permission first
    and stays off if the user blocks it. */
async function setNotifyPref(pref: Ref<boolean>, key: string, on: boolean): Promise<void> {
  if (!on) {
    pref.value = false;
    safeSetString(key, '0');
    return;
  }
  if (typeof Notification === 'undefined') return;
  let perm = Notification.permission;
  if (perm === 'default') {
    try {
      perm = await Notification.requestPermission();
    } catch {
      // ignore
    }
  }
  notifyPermission.value = perm;
  if (perm !== 'granted') return; // blocked — leave the toggle off
  pref.value = true;
  safeSetString(key, '1');
}

/** Enable/disable turn-completion notifications. */
function setNotifyOnComplete(on: boolean): Promise<void> {
  return setNotifyPref(notifyOnComplete, STORAGE_KEYS.notifyOnComplete, on);
}

/** Enable/disable question (needs-answer) notifications. Off by default. */
function setNotifyOnQuestion(on: boolean): Promise<void> {
  return setNotifyPref(notifyOnQuestion, STORAGE_KEYS.notifyOnQuestion, on);
}

/** Enable/disable approval notifications. Off by default. */
function setNotifyOnApproval(on: boolean): Promise<void> {
  return setNotifyPref(notifyOnApproval, STORAGE_KEYS.notifyOnApproval, on);
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

export function completionNotificationCopy(sessionTitle: string): NotificationCopy {
  return {
    title: i18n.global.t('settings.notifyTitle'),
    body: firstText(sessionTitle, i18n.global.t('settings.notifyFallback')),
  };
}

export function questionNotificationCopy(
  sessionTitle: string,
  questionPreview: string,
): NotificationCopy {
  return {
    title: i18n.global.t('settings.notifyQuestionTitle'),
    body: firstText(
      questionPreview,
      sessionTitle,
      i18n.global.t('settings.notifyQuestionFallback'),
    ),
  };
}

export function approvalNotificationCopy(
  sessionTitle: string,
  toolName: string,
): NotificationCopy {
  return {
    title: i18n.global.t('settings.notifyApprovalTitle'),
    body: firstText(
      toolName,
      sessionTitle,
      i18n.global.t('settings.notifyApprovalFallback'),
    ),
  };
}

/** Shared permission gate + fire. `enabled` is the caller's per-kind preference;
    `copy` and `tag` let each kind carry its own text and a per-turn/per-request
    dedup tag: repeats of the same turn or request collapse into one
    notification, while distinct ones each fire (same-tag notifications replace
    silently — renotify is unreliable across platforms — so the tag must change
    whenever a new alert should pop). */
function maybeNotify(
  enabled: boolean,
  ctx: NotifyBaseCtx,
  copy: NotificationCopy,
  tag: string,
): void {
  if (!enabled) return;
  if (typeof Notification === 'undefined') return;
  const perm = Notification.permission;
  if (perm === 'denied') return;
  if (perm === 'default') {
    // Request permission asynchronously; if granted, fire the notification.
    void Notification.requestPermission().then((p) => {
      notifyPermission.value = p;
      if (p === 'granted') fire(ctx, copy, tag);
    });
    return;
  }
  fire(ctx, copy, tag);
}

function fire(ctx: NotifyBaseCtx, copy: NotificationCopy, tag: string): void {
  if (ctx.isUserWatching) return;
  try {
    const n = new Notification(copy.title, { body: copy.body, tag, icon: NOTIFICATION_ICON });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        // ignore
      }
      ctx.onClick();
      n.close();
    };
  } catch {
    // Notification construction can throw on some platforms — ignore.
  }
}

/** Fire a completion notification for a finished session, but only when the
    caller says the user isn't already looking at it. The tag carries the turn's
    prompt id: same-tag notifications replace silently, so without it a stale
    notification left in the notification center would swallow every later
    turn's alert for that session. */
function maybeNotifyCompletion(sid: string, ctx: NotifyCompletionCtx): void {
  maybeNotify(
    notifyOnComplete.value,
    ctx,
    completionNotificationCopy(ctx.sessionTitle),
    `kimi-complete-${sid}-${ctx.promptId ?? Date.now()}`,
  );
}

/** Fire a notification when a session asks a question, but only when the user
    explicitly opted into question notifications and isn't already looking. */
function maybeNotifyQuestion(ctx: NotifyQuestionCtx): void {
  maybeNotify(
    notifyOnQuestion.value,
    ctx,
    questionNotificationCopy(ctx.sessionTitle, ctx.questionPreview),
    `kimi-question-${ctx.questionId}`,
  );
}

/** Fire a notification when a tool needs approval, but only when the user
    explicitly opted into approval notifications and isn't already looking. */
function maybeNotifyApproval(ctx: NotifyApprovalCtx): void {
  maybeNotify(
    notifyOnApproval.value,
    ctx,
    approvalNotificationCopy(ctx.sessionTitle, ctx.toolName),
    `kimi-approval-${ctx.approvalId}`,
  );
}

export function useNotification() {
  return {
    notifyOnComplete,
    notifyOnQuestion,
    notifyOnApproval,
    notifyPermission,
    setNotifyOnComplete,
    setNotifyOnQuestion,
    setNotifyOnApproval,
    maybeNotifyCompletion,
    maybeNotifyQuestion,
    maybeNotifyApproval,
  };
}
