// apps/kimi-web/src/composables/client/useNotification.ts
// Browser "turn completed" notification: the on/off preference (persisted) and
// the OS permission + Notification API. Pure UI action module — it never reads
// rawState or calls the API. The rawState-dependent bits (is the session active
// & visible, its title, the click-to-select action) are passed in by the caller
// via NotifyCompletionCtx.

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

/** Enable/disable completion notifications. Enabling requests OS permission;
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

/** Fire a completion notification for a finished session, but only when the
    caller says the user isn't already looking at it. */
function maybeNotifyCompletion(sid: string, ctx: NotifyCompletionCtx): void {
  if (!notifyOnComplete.value) return;
  if (typeof Notification === 'undefined') return;
  const perm = Notification.permission;
  if (perm === 'denied') return;
  if (perm === 'default') {
    // Request permission asynchronously; if granted, fire the notification.
    void Notification.requestPermission().then((p) => {
      notifyPermission.value = p;
      if (p === 'granted') fire(sid, ctx);
    });
    return;
  }
  fire(sid, ctx);
}

function fire(sid: string, ctx: NotifyCompletionCtx): void {
  if (ctx.isActiveAndVisible) return;
  const title = ctx.sessionTitle.trim() || 'Kimi Code';
  try {
    const n = new Notification(title, {
      body: i18n.global.t('settings.notifyBody'),
      tag: `kimi-complete-${sid}`,
    });
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

export function useNotification() {
  return {
    notifyOnComplete,
    notifyPermission,
    setNotifyOnComplete,
    maybeNotifyCompletion,
  };
}
