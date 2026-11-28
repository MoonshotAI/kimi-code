
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

  function syncPermission(): string {
    const permission = typeof Notification !== 'undefined' ? Notification.permission : 'denied';
    notifyPermission.value = permission;
    return permission;
  }

  async function requestPermission(): Promise<string> {
    if (typeof Notification === 'undefined') return 'denied';
    if (Notification.permission !== 'default') return syncPermission();
    try {
      notifyPermission.value = await Notification.requestPermission();
    } catch {
      syncPermission();
    }
    return notifyPermission.value;
  }

  async function setNotifyEnabled(on: boolean): Promise<void> {
    if (!on) {
      notifyEnabled.value = false;
      safeSetString(STORAGE_KEYS.notifyEnabled, '0');
      return;
    }
    if ((await requestPermission()) !== 'granted') return;
    notifyEnabled.value = true;
    safeSetString(STORAGE_KEYS.notifyEnabled, '1');
  }

  function setNotifySound(on: boolean): void {
    notifySound.value = on;
    safeSetString(STORAGE_KEYS.notifySound, on ? '1' : '0');
  }

  function maybeNotify(ctx: NotifyBaseCtx, copy: NotificationCopy, tag: string): void {
    if (!notifyEnabled.value) return;
    if (typeof Notification === 'undefined') return;
    const perm = syncPermission();
    if (perm === 'denied') return;
    if (perm === 'default') {
      void requestPermission().then((p) => {
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
          (window as { kimiDesktop?: { showWindow?: () => void } }).kimiDesktop?.showWindow?.();
          window.focus();
        } catch {}
        if (kind !== undefined) track('notification_clicked', { kind });
        ctx.onClick();
        n.close();
      };
    } catch {}
  }

  function maybeNotifyCompletion(sid: string, ctx: NotifyCompletionCtx): void {
    maybeNotify(
      ctx,
      completionNotificationCopy(t, ctx.sessionTitle),
      `kimi-complete-${sid}-${ctx.promptId ?? Date.now()}`,
    );
  }

  function maybeNotifyQuestion(ctx: NotifyQuestionCtx): void {
    maybeNotify(
      ctx,
      questionNotificationCopy(t, ctx.sessionTitle, ctx.questionPreview),
      `kimi-question-${ctx.questionId}`,
    );
  }

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
    syncPermission,
    requestPermission,
    setNotifyEnabled,
    setNotifySound,
    maybeNotifyCompletion,
    maybeNotifyQuestion,
    maybeNotifyApproval,
  };
});

export function notificationsStore() {
  return useNotificationsStore(clientPinia);
}
