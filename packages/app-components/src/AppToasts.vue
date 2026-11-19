<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppNotice } from '@moonshot-ai/app-core/api';
import { dismissToastByKey, onToast, type ToastEvent } from '@moonshot-ai/app-client/client';
import { warningsStore, warningKey } from '@moonshot-ai/app-client/stores';
import { dockHeightPx } from '@moonshot-ai/app-client/lib';
import { Toast, type ToastOptions, type ToastPosition, type ToastVariant } from '@moonshot-ai/app-ui';

const { t } = useI18n();

function transitionName(position: ToastPosition): string {
  if (position === 'bottom-right') return 'app-toast-right';
  return position.startsWith('top') ? 'app-toast-top' : 'app-toast-bottom';
}

interface CommandItem {
  id: number;
  key?: number;
  options: ToastOptions;
}

let nextCommandId = 1;
const commandItems = ref<CommandItem[]>([]);

function removeCommand(id: number): void {
  commandItems.value = commandItems.value.filter((item) => item.id !== id);
}

function closeCommand(id: number): void {
  const item = commandItems.value.find((item) => item.id === id);
  if (!item) return;
  removeCommand(id);
  if (item.key !== undefined) dismissToastByKey(item.key);
}

const offToast = onToast((event: ToastEvent) => {
  if (event.type === 'dismiss') {
    const item = commandItems.value.find((item) => item.key === event.key);
    if (item) removeCommand(item.id);
    return;
  }
  const options = event.options;
  if (!options) return;
  const mode = options.mode ?? 'stack';
  const position = options.position ?? 'top-center';
  if (mode === 'replace') {
    const isReplaced = (item: CommandItem) =>
      (item.options.mode ?? 'stack') === 'replace' && (item.options.position ?? 'top-center') === position;
    const replacedKeys = commandItems.value.filter(isReplaced).map((item) => item.key);
    commandItems.value = commandItems.value.filter((item) => !isReplaced(item));
    for (const key of replacedKeys) {
      if (key !== undefined) dismissToastByKey(key);
    }
  }
  commandItems.value = [...commandItems.value, { id: nextCommandId++, key: event.key, options }];
});
onUnmounted(offToast);

interface NoticeItem {
  id: number;
  key: string;
  warning: AppNotice;
}

let nextNoticeId = 1;
const noticeItems = ref<NoticeItem[]>([]);

watch(
  () => warningsStore().warnings,
  (next) => {
    const unmatched = [...noticeItems.value];
    noticeItems.value = next.map((warning) => {
      const key = warningKey(warning);
      const at = unmatched.findIndex((item) => item.key === key);
      const reused = at === -1 ? undefined : unmatched.splice(at, 1)[0];
      if (reused) {
        reused.warning = warning;
        return reused;
      }
      return { id: nextNoticeId++, key, warning };
    });
  },
  { immediate: true, flush: 'post' },
);

function closeNotice(item: NoticeItem): void {
  noticeItems.value = noticeItems.value.filter((current) => current.id !== item.id);
  warningsStore().dismissWarning(item.warning);
}

function noticeVariant(warning: AppNotice): ToastVariant {
  if (warning.severity === 'error') return 'danger';
  if (warning.severity === 'success') return 'success';
  if (warning.severity === 'info') return 'info';
  return 'warning';
}

function noticeOptions(warning: AppNotice): ToastOptions {
  return {
    variant: noticeVariant(warning),
    title: warning.title,
    message: warning.message ?? '',
    details: warning.details,
    copyLink: warning.copyLink,
    dismissLabel: t('warnings.dismiss'),
    position: warning.position,
  };
}

interface GroupItem {
  key: string;
  options: ToastOptions;
  close: () => void;
}

const POSITIONS: ToastPosition[] = ['top-center', 'top-right', 'bottom-center', 'bottom-right'];

const groups = computed(() =>
  POSITIONS.map((position) => {
    const items: GroupItem[] = [];
    for (const item of commandItems.value) {
      if ((item.options.position ?? 'top-center') !== position) continue;
      items.push({
        key: `c${item.id}`,
        options: item.options,
        close: () => closeCommand(item.id),
      });
    }
    for (const item of noticeItems.value) {
      const options = noticeOptions(item.warning);
      if ((options.position ?? 'top-center') !== position) continue;
      items.push({
        key: `n${item.id}`,
        options,
        close: () => closeNotice(item),
      });
    }
    return { position, items };
  }),
);

const dockStyle = computed(() =>
  dockHeightPx.value != null ? { '--dock-h': `${dockHeightPx.value}px` } : undefined,
);
</script>

<template>
  <template v-for="group in groups" :key="group.position">
    <div
      v-if="group.items.length > 0"
      class="app-toasts"
      :data-position="group.position"
      :style="dockStyle"
      aria-live="polite"
    >
      <TransitionGroup
        :name="transitionName(group.position)"
        tag="div"
        class="app-toasts__list"
      >
        <template v-for="item in group.items" :key="item.key">
          <component v-if="item.options.presentation" :is="item.options.presentation" :dismiss="item.close" />
          <Toast v-else v-bind="item.options" @close="item.close()">
            <template v-if="item.options.body" #default>
              <component :is="item.options.body" />
            </template>
          </Toast>
        </template>
      </TransitionGroup>
    </div>
  </template>
</template>

<style scoped>
.app-toasts {
  position: fixed;
  z-index: var(--z-toast);
  max-height: 56vh;
  overflow-y: auto;
  padding: 4px;
}
.app-toasts__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.app-toasts[data-position="top-center"] { top: calc(48px + var(--space-2)); }
.app-toasts[data-position="top-right"] { top: calc(48px + var(--space-2)); right: 16px; }
.app-toasts[data-position="bottom-center"] { bottom: 24px; }
.app-toasts[data-position="bottom-right"] {
  bottom: 84px;
  right: 16px;
  width: min(440px, calc(100vw - 32px));
}
.app-toasts[data-position="top-center"],
.app-toasts[data-position="bottom-center"] {
  left: 0;
  right: 0;
  pointer-events: none;
}
.app-toasts[data-position="top-center"] .app-toasts__list,
.app-toasts[data-position="bottom-center"] .app-toasts__list { align-items: center; }
.app-toasts[data-position="top-right"] .app-toasts__list { align-items: flex-end; }
.app-toasts[data-position="bottom-right"] :deep(.ui-toast) { width: 100%; }
.app-toasts :deep(.ui-toast),
.app-toasts :deep(.ui-toast-bar) { pointer-events: auto; }

.app-toast-top-enter-active,
.app-toast-top-leave-active,
.app-toast-bottom-enter-active,
.app-toast-bottom-leave-active {
  transition: opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.app-toast-top-leave-active,
.app-toast-bottom-leave-active {
  transition-duration: var(--duration-fast);
  pointer-events: none;
}
.app-toast-top-enter-from,
.app-toast-top-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.app-toast-bottom-enter-from,
.app-toast-bottom-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
.app-toast-top-move,
.app-toast-bottom-move {
  transition: transform var(--duration-base) var(--ease-out);
}
.app-toast-right-enter-active,
.app-toast-right-leave-active {
  transition: opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.app-toast-right-leave-active {
  transition-duration: var(--duration-fast);
  pointer-events: none;
}
.app-toast-right-enter-from,
.app-toast-right-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
.app-toast-right-move {
  transition: transform var(--duration-base) var(--ease-out);
}

@media (max-width: 640px) {
  .app-toasts { max-height: 50vh; }
  .app-toasts[data-position="bottom-center"],
  .app-toasts[data-position="bottom-right"] { bottom: calc(var(--dock-h, 76px) + 8px); }
  .app-toasts[data-position="bottom-right"] {
    left: 12px;
    right: 12px;
    width: auto;
  }
}
</style>
