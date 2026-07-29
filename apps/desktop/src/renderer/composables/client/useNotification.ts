// apps/web/src/composables/client/useNotification.ts
// System notifications for when the agent needs attention: a turn finished, a
// question waiting for an answer, or a tool needing approval. One master
// on/off preference (persisted, default on) gates all three kinds, plus a
// sound preference (default on) that controls whether the notification plays
// the system sound (`silent`). Both sit on top of the shared OS permission +
// Notification API. Pure UI action module — it never reads rawState or calls
// the API. The rawState-dependent bits (is the user watching the session, its
// title, the click-to-select action) are passed in by the caller via the ctx
// objects.

import { ref } from 'vue';
import { i18n } from '../../i18n';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../../lib/storage';
import { track } from '../../lib/track';
import type { NotificationKindEvent } from '../../../shared/track-events';

type NotificationKind = NotificationKindEvent['kind'];

// The tag prefix identifies the kind (see maybeNotify* below).
function kindFromTag(tag: string): NotificationKind | undefined {
  if (tag.startsWith('kimi-complete-')) return 'turn_complete';
  if (tag.startsWith('kimi-question-')) return 'question';
  if (tag.startsWith('kimi-approval-')) return 'approval';
  return undefined;
}

export function shouldNotifyCompletion(
  status: 'idle' | 'aborted',
  hasPendingApproval: boolean,
  hasPendingQuestion: boolean,
): boolean {
  return status === 'idle' && !hasPendingApproval && !hasPendingQuestion;
}

function loadPref(key: string, defaultOn: boolean): boolean {
  const v = safeGetString(key);
  return v === null ? defaultOn : v === '1';
}

const notifyEnabled = ref(loadPref(STORAGE_KEYS.notifyEnabled, true));
const notifySound = ref(loadPref(STORAGE_KEYS.notifySound, true));
const notifyPermission = ref<string>(
  typeof Notification !== 'undefined' ? Notification.permission : 'denied',
);

const NOTIFICATION_ICON = '/favicon.ico';

/** Enable/disable notifications. Disabling is instant; enabling requests OS
    permission first and stays off if the user blocks it. */
async function setNotifyEnabled(on: boolean): Promise<void> {
  if (!on) {
    notifyEnabled.value = false;
    safeSetString(STORAGE_KEYS.notifyEnabled, '0');
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
  notifyEnabled.value = true;
  safeSetString(STORAGE_KEYS.notifyEnabled, '1');
}

/** Enable/disable the notification sound. Persisted across reloads. */
function setNotifySound(on: boolean): void {
  notifySound.value = on;
  safeSetString(STORAGE_KEYS.notifySound, on ? '1' : '0');
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

/** Shared permission gate + fire. `copy` and `tag` let each kind carry its own
    text and a per-turn/per-request dedup tag: repeats of the same turn or
    request collapse into one notification, while distinct ones each fire
    (same-tag notifications replace silently — renotify is unreliable across
    platforms — so the tag must change whenever a new alert should pop). */
function maybeNotify(ctx: NotifyBaseCtx, copy: NotificationCopy, tag: string): void {
  if (!notifyEnabled.value) return;
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
    const n = new Notification(copy.title, {
      body: copy.body,
      tag,
      icon: NOTIFICATION_ICON,
      silent: !notifySound.value,
    });
    const kind = kindFromTag(tag);
    if (kind !== undefined) track('notification_shown', { kind });
    n.onclick = () => {
      try {
        // Desktop hide-on-close: the native window may be alive but hidden,
        // and window.focus() can't un-hide it — ask the main process to show
        // it (no-op without the bridge: web, old desktop builds).
        (window as { kimiDesktop?: { showWindow?: () => void } }).kimiDesktop?.showWindow?.();
        window.focus();
      } catch {
        // ignore
      }
      if (kind !== undefined) track('notification_clicked', { kind });
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
    ctx,
    completionNotificationCopy(ctx.sessionTitle),
    `kimi-complete-${sid}-${ctx.promptId ?? Date.now()}`,
  );
}

/** Fire a notification when a session asks a question, but only when the user
    isn't already looking. */
function maybeNotifyQuestion(ctx: NotifyQuestionCtx): void {
  maybeNotify(
    ctx,
    questionNotificationCopy(ctx.sessionTitle, ctx.questionPreview),
    `kimi-question-${ctx.questionId}`,
  );
}

/** Fire a notification when a tool needs approval, but only when the user
    isn't already looking. */
function maybeNotifyApproval(ctx: NotifyApprovalCtx): void {
  maybeNotify(
    ctx,
    approvalNotificationCopy(ctx.sessionTitle, ctx.toolName),
    `kimi-approval-${ctx.approvalId}`,
  );
}

export function useNotification() {
  return {
    notifyEnabled,
    notifySound,
    notifyPermission,
    setNotifyEnabled,
    setNotifySound,
    maybeNotifyCompletion,
    maybeNotifyQuestion,
    maybeNotifyApproval,
  };
}
