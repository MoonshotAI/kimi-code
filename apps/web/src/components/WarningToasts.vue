<!-- apps/kimi-web/src/components/WarningToasts.vue -->
<!-- Floating stack of warning/error messages collected in the app state. -->
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppNotice, AppWarning } from '../api/types';
import { copyTextToClipboard } from '../lib/clipboard';
import Toast from './ui/Toast.vue';

const props = defineProps<{ warnings: AppWarning[] }>();
const emit = defineEmits<{ dismiss: [index: number] }>();

const { t } = useI18n();

function isNotice(warning: AppWarning): warning is AppNotice {
  return typeof warning === 'object' && warning !== null;
}

function toastTitle(warning: AppWarning): string {
  return isNotice(warning) ? warning.title : warning;
}

function toastMessage(warning: AppWarning): string {
  return isNotice(warning) ? (warning.message ?? '') : '';
}

function toastDetails(warning: AppWarning): AppNotice['details'] {
  return isNotice(warning) ? warning.details : undefined;
}

function isError(warning: AppWarning): boolean {
  if (isNotice(warning)) return warning.severity === 'error';
  return warning.startsWith(`${t('warnings.errorLabel')}:`) || /\b4\d\d\b|error|失败|failed/i.test(warning);
}

function warningKey(warning: AppWarning): string {
  if (!isNotice(warning)) return `text:${warning}`;
  return `notice:${warning.severity}:${warning.title}:${warning.message ?? ''}:${JSON.stringify(warning.details ?? [])}`;
}

function formatWarningForCopy(warning: AppWarning): string {
  if (!isNotice(warning)) return warning;
  const lines = [warning.title];
  if (warning.message) lines.push(warning.message);
  const details = warning.details ?? [];
  if (details.length > 0) {
    lines.push('', `${t('warnings.diagnostics')}:`);
    for (const detail of details) {
      lines.push(`${detail.label}: ${detail.value}`);
    }
  }
  return lines.join('\n');
}

/** One entry per visible toast. `id` is a unique per-instance key so repeated
    identical texts each get their own auto-dismiss timer. */
interface ToastItem {
  id: number;
  key: string;
  warning: AppWarning;
  detailsOpen: boolean;
  copied: boolean;
}

let nextId = 1;
const toasts = ref<ToastItem[]>([]);

/** Auto-dismiss timer per toast instance. `handle` is null while paused
    (pointer over the toast or details open); `remaining` then holds the
    leftover time. */
interface ToastTimer {
  handle: ReturnType<typeof setTimeout> | null;
  deadline: number;
  remaining: number;
}
const timers = new Map<number, ToastTimer>();
const copiedTimers = new Map<number, ReturnType<typeof setTimeout>>();

function toastDuration(warning: AppWarning): number {
  const base = isError(warning) ? 12000 : 6000;
  // Touch screens have no hover-to-pause, so grant extra reading time.
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches === true;
  return touch ? base + 5000 : base;
}

function runTimer(id: number, ms: number): void {
  const entry = timers.get(id) ?? { handle: null, deadline: 0, remaining: 0 };
  entry.handle = setTimeout(() => dismissById(id), ms);
  entry.deadline = Date.now() + ms;
  timers.set(id, entry);
}

function clearTimer(id: number): void {
  const entry = timers.get(id);
  if (entry && entry.handle !== null) clearTimeout(entry.handle);
  timers.delete(id);
}

function pauseTimer(id: number): void {
  const entry = timers.get(id);
  if (!entry || entry.handle === null) return;
  clearTimeout(entry.handle);
  entry.handle = null;
  entry.remaining = Math.max(0, entry.deadline - Date.now());
}

function resumeTimer(id: number): void {
  const toast = toasts.value.find((item) => item.id === id);
  if (toast?.detailsOpen) return;
  const entry = timers.get(id);
  if (!entry || entry.handle !== null) return;
  runTimer(id, entry.remaining);
}

function toggleDetails(toast: ToastItem): void {
  toast.detailsOpen = !toast.detailsOpen;
  if (toast.detailsOpen) {
    pauseTimer(toast.id);
  } else {
    resumeTimer(toast.id);
  }
}

async function copyDetails(toast: ToastItem): Promise<void> {
  const ok = await copyTextToClipboard(formatWarningForCopy(toast.warning));
  if (!ok) return;
  toast.copied = true;
  const prev = copiedTimers.get(toast.id);
  if (prev) clearTimeout(prev);
  copiedTimers.set(
    toast.id,
    setTimeout(() => {
      toast.copied = false;
      copiedTimers.delete(toast.id);
    }, 1400),
  );
}

/** Used by both the timer expiry and the manual close button. Removes the
    toast locally first so a later reconcile can't mismatch duplicate texts. */
function dismissById(id: number): void {
  clearTimer(id);
  const copiedTimer = copiedTimers.get(id);
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimers.delete(id);
  const idx = toasts.value.findIndex((item) => item.id === id);
  if (idx === -1) return;
  toasts.value = toasts.value.filter((item) => item.id !== id);
  emit('dismiss', idx);
}

// Reconcile local toast instances with the warnings prop: reuse instances
// (and their running timers) for warnings still present, create fresh instances
// with fresh timers for new warnings, and clear timers of removed ones.
watch(
  () => props.warnings,
  (next) => {
    const unmatched = [...toasts.value];
    toasts.value = next.map((warning) => {
      const key = warningKey(warning);
      const at = unmatched.findIndex((item) => item.key === key);
      const reused = at === -1 ? undefined : unmatched.splice(at, 1)[0];
      if (reused) {
        reused.warning = warning;
        return reused;
      }
      const item: ToastItem = { id: nextId++, key, warning, detailsOpen: false, copied: false };
      runTimer(item.id, toastDuration(warning));
      return item;
    });
    for (const gone of unmatched) {
      clearTimer(gone.id);
      const copiedTimer = copiedTimers.get(gone.id);
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimers.delete(gone.id);
    }
  },
  { immediate: true, flush: 'post' },
);

onUnmounted(() => {
  timers.forEach((entry) => {
    if (entry.handle !== null) clearTimeout(entry.handle);
  });
  timers.clear();
  copiedTimers.forEach((entry) => clearTimeout(entry));
  copiedTimers.clear();
});
</script>

<template>
  <TransitionGroup name="toast" tag="div" class="toasts" role="status" aria-live="polite">
    <Toast
      v-for="toast in toasts"
      :key="toast.id"
      :variant="isError(toast.warning) ? 'danger' : 'warning'"
      :title="toastTitle(toast.warning)"
      :message="toastMessage(toast.warning)"
      :dismiss-label="t('warnings.dismiss')"
      @dismiss="dismissById(toast.id)"
      @pointerenter="pauseTimer(toast.id)"
      @pointerleave="resumeTimer(toast.id)"
    >
      <div v-if="toastDetails(toast.warning)?.length" class="actions">
        <button class="link" type="button" @click="toggleDetails(toast)">
          {{ toast.detailsOpen ? t('warnings.hideDetails') : t('warnings.showDetails') }}
        </button>
        <button class="link" type="button" @click="copyDetails(toast)">
          {{ toast.copied ? t('warnings.copied') : t('warnings.copyDetails') }}
        </button>
      </div>
      <dl v-if="toast.detailsOpen && toastDetails(toast.warning)?.length" class="details">
        <div v-for="detail in toastDetails(toast.warning)" :key="`${detail.label}:${detail.value}`" class="detail-row">
          <dt>{{ detail.label }}</dt>
          <dd>{{ detail.value }}</dd>
        </div>
      </dl>
    </Toast>
  </TransitionGroup>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 16px;
  bottom: 84px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  z-index: var(--z-toast);
  width: min(440px, calc(100vw - 32px));
  max-height: 56vh;
  overflow-y: auto;
}

/* Toast enter/leave/move: new toasts slide in from the right and fade; dismissed
   toasts fade + slide out in place, then the remaining stack glides up via
   `.toast-move` (no absolute positioning, so a middle toast never jumps to the
   top of the stack as it leaves). */
.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
.toast-move {
  transition: transform var(--duration-base) var(--ease-out);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--color-accent);
  cursor: pointer;
  font: inherit;
  font-size: var(--ui-font-size-xs);
}
.link:hover {
  text-decoration: underline;
}
.details {
  display: grid;
  gap: 5px;
  margin: 8px 0 0;
  padding: 8px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
}
.detail-row {
  display: grid;
  grid-template-columns: minmax(88px, 0.34fr) minmax(0, 1fr);
  gap: 8px;
}
.detail-row dt {
  color: var(--color-text-muted);
}
.detail-row dd {
  margin: 0;
  color: var(--color-text);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
@media (max-width: 640px) {
  .toasts {
    left: 12px;
    right: 12px;
    bottom: calc(76px + env(safe-area-inset-bottom));
    width: auto;
    max-height: 50vh;
  }
  .detail-row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
