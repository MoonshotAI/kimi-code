<!-- apps/kimi-web/src/components/WarningToasts.vue -->
<!-- Floating stack of warning/error messages collected in the app state.
     Without this, agent errors (e.g. a 403 from the model provider) and load
     failures were silently swallowed. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';

defineProps<{ warnings: string[] }>();
const emit = defineEmits<{ dismiss: [index: number] }>();

const { t } = useI18n();

function isError(w: string): boolean {
  return w.startsWith(`${t('warnings.errorLabel')}:`) || /\b4\d\d\b|error|失败|failed/i.test(w);
}
</script>

<template>
  <div v-if="warnings.length" class="toasts" role="status" aria-live="polite">
    <div v-for="(w, i) in warnings" :key="i" class="toast" :class="{ err: isError(w) }">
      <span class="dot" aria-hidden="true"></span>
      <span class="msg">{{ w }}</span>
      <button class="x" type="button" :aria-label="t('warnings.dismiss')" @click="emit('dismiss', i)">
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 16px;
  bottom: 84px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 60;
  width: min(380px, calc(100vw - 32px));
  max-height: 56vh;
  overflow-y: auto;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 9px 9px 11px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.12);
  font-size: 12px;
  line-height: 1.5;
}
/* Error toasts: a subtle red-tinted border (no left accent bar); the red dot
   is the primary error cue. */
.toast.err {
  border-color: rgba(192, 57, 43, 0.35);
}
.dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--muted);
}
.toast.err .dot {
  background: #c0392b;
}
.msg {
  flex: 1;
  color: var(--ink);
  word-break: break-word;
}
.toast.err .msg {
  color: #a93226;
}
.x {
  flex: none;
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--muted);
  padding: 1px 2px;
  display: flex;
  align-items: center;
  border-radius: 4px;
}
.x:hover {
  color: var(--ink);
  background: var(--hover, rgba(0, 0, 0, 0.05));
}

/* ---- Mobile: full-width stack with side margins, just above the composer. ----
   The desktop corner card (min(380px, …)) is too narrow + right-anchored for a
   phone; here we stretch edge-to-edge (minus 12px gutters) and bump the bottom
   offset above the composer + its safe-area inset. Dismiss tap target grows. */
@media (max-width: 640px) {
  .toasts {
    left: 12px;
    right: 12px;
    bottom: calc(76px + env(safe-area-inset-bottom));
    width: auto;
    max-height: 50vh;
  }
  .toast {
    padding: 11px 11px 11px 13px;
    border-radius: 10px;
  }
  .x {
    width: 28px;
    height: 28px;
    margin: -4px -4px -4px 0;
    justify-content: center;
  }
}
</style>
