// apps/kimi-web/src/composables/client/useNotification.ts
// Browser notifications for when the agent needs attention: a turn finished or
// a question is waiting for an answer. The on/off preference (persisted) and
// the OS permission + Notification API. Pure UI action module — it never reads
// rawState or calls the API. The rawState-dependent bits (is the session active
// & visible, its title, the click-to-select action) are passed in by the caller
// via the ctx objects.

import { ref } from 'vue';
import { i18n } from '../../i18n';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../../lib/storage';

function loadNotify(): boolean {
  const v = safeGetString(STORAGE_KEYS.notifyOnComplete);
  return v === null ? true : v === '1';
}

const notifyOnComplete = ref(loadNotify());
const notifyPermission = ref<string>(
  typeof Notification !== 'undefined' ? Notification.permission : 'denied',
);

/** Enable/disable attention notifications. Enabling requests OS permission;
    if the user blocks it the preference stays off. */
async function setNotifyOnComplete(on: boolean): Promise<void> {
  if (!on) {
    notifyOnComplete.value = false;
    safeSetString(STORAGE_KEYS.notifyOnComplete, '0');
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
  notifyOnComplete.value = true;
  safeSetString(STORAGE_KEYS.notifyOnComplete, '1');
}

export interface NotifyCompletionCtx {
  /** True when the target session is the active one and the page is visible —
      in which case we suppress the notification. */
  isActiveAndVisible: boolean;
  /** Session title used as the notification title. */
  sessionTitle: string;
  /** Called when the user clicks the notification (e.g. select the session). */
  onClick: () => void;
}

export interface NotifyQuestionCtx extends NotifyCompletionCtx {
  /** Short preview of the question, used as the notification body. Falls back
      to a generic line when empty. */
  questionPreview: string;
}

/** Shared permission gate + fire. `body` and `tag` let each kind carry its own
    text and a per-kind dedup tag so a completion and a question don't collapse
    into one notification. */
function maybeNotify(ctx: NotifyCompletionCtx, body: string, tag: string): void {
  if (!notifyOnComplete.value) return;
  if (typeof Notification === 'undefined') return;
  const perm = Notification.permission;
  if (perm === 'denied') return;
  if (perm === 'default') {
    // Request permission asynchronously; if granted, fire the notification.
    void Notification.requestPermission().then((p) => {
      notifyPermission.value = p;
      if (p === 'granted') fire(ctx, body, tag);
    });
    return;
  }
  fire(ctx, body, tag);
}

function fire(ctx: NotifyCompletionCtx, body: string, tag: string): void {
  if (ctx.isActiveAndVisible) return;
  const title = ctx.sessionTitle.trim() || 'Kimi Code';
  try {
    const n = new Notification(title, { body, tag });
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
    caller says the user isn't already looking at it. */
function maybeNotifyCompletion(sid: string, ctx: NotifyCompletionCtx): void {
  maybeNotify(ctx, i18n.global.t('settings.notifyBody'), `kimi-complete-${sid}`);
}

/** Fire a notification when a session asks a question, but only when the
    caller says the user isn't already looking at it. */
function maybeNotifyQuestion(sid: string, ctx: NotifyQuestionCtx): void {
  const body = ctx.questionPreview || i18n.global.t('settings.notifyQuestionBody');
  maybeNotify(ctx, body, `kimi-question-${sid}`);
}

export function useNotification() {
  return {
    notifyOnComplete,
    notifyPermission,
    setNotifyOnComplete,
    maybeNotifyCompletion,
    maybeNotifyQuestion,
  };
}
