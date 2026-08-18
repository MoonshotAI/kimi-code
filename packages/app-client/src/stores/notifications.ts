// Notifications domain store (P9).
//
// System notifications for when the agent needs attention: a turn finished, a
// question waiting for an answer, or a tool needing approval. One master
// on/off preference (persisted, default on) gates all three kinds, plus a
// sound preference (default on) that controls whether the notification plays
// the system sound (`silent`). Both sit on top of the shared OS permission +
// Notification API. The store never reads the facade's rawState or calls the
// API — the rawState-dependent bits (is the user watching the session, its
// title, the click-to-select action) are passed in by the caller via the ctx
// objects. The copy builders and `shouldNotifyCompletion` stay in
// composables/useNotification.ts (pure, translator-injected).

import { ref } from 'vue';
import { defineStore } from 'pinia';
import { safeGetString, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { track } from '../contracts';
import { t } from '../client/deps';
import {
  approvalNotificationCopy,
  completionNotificationCopy,
  questionNotificationCopy,
  type NotificationCopy,
  type NotifyApprovalCtx,
  type NotifyBaseCtx,
  type NotifyCompletionCtx,
  type NotifyQuestionCtx,
} from '../composables/useNotification';
import { clientPinia } from './pinia';

type NotificationKind = 'turn_complete' | 'question' | 'approval';

// The tag prefix identifies the kind (see maybeNotify* below).
function kindFromTag(tag: string): NotificationKind | undefined {
  if (tag.startsWith('kimi-complete-')) return 'turn_complete';
  if (tag.startsWith('kimi-question-')) return 'question';
  if (tag.startsWith('kimi-approval-')) return 'approval';
  return undefined;
}

function loadPref(key: string, defaultOn: boolean): boolean {
  const v = safeGetString(key);
  return v === null ? defaultOn : v === '1';
}

const NOTIFICATION_ICON = '/favicon.ico';

export const useNotificationsStore = defineStore('kimi.notifications', () => {
  const notifyEnabled = ref(loadPref(STORAGE_KEYS.notifyEnabled, true));
  const notifySound = ref(loadPref(STORAGE_KEYS.notifySound, true));
  const notifyPermission = ref<string>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  );

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
      completionNotificationCopy(t, ctx.sessionTitle),
      `kimi-complete-${sid}-${ctx.promptId ?? Date.now()}`,
    );
  }

  /** Fire a notification when a session asks a question, but only when the user
      isn't already looking. */
  function maybeNotifyQuestion(ctx: NotifyQuestionCtx): void {
    maybeNotify(
      ctx,
      questionNotificationCopy(t, ctx.sessionTitle, ctx.questionPreview),
      `kimi-question-${ctx.questionId}`,
    );
  }

  /** Fire a notification when a tool needs approval, but only when the user
      isn't already looking. */
  function maybeNotifyApproval(ctx: NotifyApprovalCtx): void {
    maybeNotify(
      ctx,
      approvalNotificationCopy(t, ctx.sessionTitle, ctx.toolName),
      `kimi-approval-${ctx.approvalId}`,
    );
  }

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
});

/** Module-level-safe accessor: resolves the store against the package-held
 *  pinia instance, so import-time singleton code (the client composables) can
 *  call it before any app has installed the pinia plugin. */
export function notificationsStore() {
  return useNotificationsStore(clientPinia);
}
