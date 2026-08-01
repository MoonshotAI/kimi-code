<!-- apps/kimi-web/src/components/ui/ActionToast.vue -->
<!-- Design-system §03 Action toast: top-center floating pill for undoable-action
     feedback — a one-line sentence (default slot) whose actions are inline
     <button>s, + close. Self-timed (hover pauses); the parent re-keys to reset
     and wraps it in a <Transition> for enter/leave. -->
<script setup lang="ts">
import { onUnmounted } from 'vue';
import { useKimiI18n } from '@moonshot-ai/web-i18n';
import IconButton from './IconButton.vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  /** Auto-dismiss delay in ms (the close button always dismisses immediately). */
  duration?: number;
  dismissLabel?: string;
}>(), {
  duration: 8000,
});

const emit = defineEmits<{ dismiss: [] }>();

const { t } = useKimiI18n();

// Auto-dismiss timer with hover pause: `handle` is null while paused (pointer
// over the toast), `remaining` then holds the leftover time.
let handle: ReturnType<typeof setTimeout> | null = null;
let deadline = 0;
let remaining = 0;

function run(ms: number): void {
  handle = setTimeout(() => emit('dismiss'), ms);
  deadline = Date.now() + ms;
}
function pause(): void {
  if (handle === null) return;
  clearTimeout(handle);
  handle = null;
  remaining = Math.max(0, deadline - Date.now());
}
function resume(): void {
  if (handle !== null) return;
  run(remaining);
}

run(props.duration);
onUnmounted(() => {
  if (handle !== null) clearTimeout(handle);
});
</script>

<template>
  <div class="ui-action-toast-host">
    <div class="ui-action-toast" role="status" @pointerenter="pause" @pointerleave="resume">
      <span class="ui-action-toast__body"><slot /></span>
      <IconButton
        class="ui-action-toast__close"
        size="sm"
        :label="dismissLabel ?? t('common.dismiss')"
        @click="emit('dismiss')"
      >
        <Icon name="close" size="sm" />
      </IconButton>
    </div>
  </div>
</template>

<style scoped>
/* Content-sized host centered via the `translate` property (kept separate
   from `transform`, which a wrapping <Transition> owns for enter/leave
   motion). No pointer-events tricks: the host IS the pill's footprint. */
.ui-action-toast-host {
  position: fixed;
  /* Float just below the 48px conversation header, not over it. */
  top: calc(48px + var(--space-2));
  left: 50%;
  translate: -50% 0;
  z-index: var(--z-toast);
  max-width: calc(100vw - 32px);
}
.ui-action-toast {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 6px 4px 14px;
  background: var(--color-surface-raised);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: 1.45;
  color: var(--color-text);
  white-space: nowrap;
}
.ui-action-toast__body { min-width: 0; }
/* The sentence's actions are plain slotted <button>s — styled here once so
   every caller gets the accent inline-link look for free. */
.ui-action-toast__body :slotted(button) {
  border: 0;
  padding: 0;
  background: none;
  color: var(--color-accent);
  cursor: pointer;
  font: inherit;
}
.ui-action-toast__body :slotted(button:hover) {
  color: var(--color-accent-hover);
  text-decoration: underline;
}
.ui-action-toast__body :slotted(button:focus-visible) {
  outline: none;
  box-shadow: var(--p-focus-ring);
  border-radius: var(--radius-xs);
}
.ui-action-toast__close { flex: none; }
</style>
