<!-- apps/kimi-web/src/components/ui/Dialog.vue -->
<!-- Design-system §03 Dialog: one canonical dialog replacing the 6 hand-written
     ones. radius xl + shadow xl, head(title/desc/close) / body / foot(right).
     Includes focus trap, Esc-to-close, and optional overlay-click-to-close. -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { openDialogCount } from '../../composables/dialogStack';
import IconButton from './IconButton.vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  open: boolean;
  title?: string;
  description?: string;
  closeOnOverlay?: boolean;
  closeOnEsc?: boolean;
  /** md 440 (default) · lg 640 · xl 760 (var(--p-content-max)). */
  size?: 'md' | 'lg' | 'xl';
  /** auto (default) = height tracks content up to max-height; fixed = constant
   *  height so the frame never resizes between tabs/content (body scrolls). */
  height?: 'auto' | 'fixed';
  /** When false, the body has no padding so the consumer controls layout
   *  (e.g. a full-bleed side-nav). */
  padded?: boolean;
}>(), {
  closeOnOverlay: true,
  closeOnEsc: true,
  size: 'md',
  height: 'auto',
  padded: true,
});

const emit = defineEmits<{
  'update:open': [value: boolean];
  close: [];
}>();

const panel = ref<HTMLElement | null>(null);
let previouslyFocused: Element | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function close() {
  emit('update:open', false);
  emit('close');
}

function focusables(): HTMLElement[] {
  return panel.value ? Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
}

function onKeydown(event: KeyboardEvent) {
  if (!props.open) return;
  if (event.key === 'Escape' && props.closeOnEsc) {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const list = focusables();
  const first = list[0];
  const last = list[list.length - 1];
  if (!first || !last) {
    event.preventDefault();
    panel.value?.focus();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function onOverlayClick(event: MouseEvent) {
  if (props.closeOnOverlay && event.target === event.currentTarget) close();
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      openDialogCount.value += 1;
      previouslyFocused = document.activeElement;
      await nextTick();
      const list = focusables();
      (list[0] ?? panel.value)?.focus();
    } else {
      openDialogCount.value = Math.max(0, openDialogCount.value - 1);
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
        previouslyFocused = null;
      }
    }
  },
  // Run immediately so callers that mount with `open` already true (Login,
  // AddWorkspace, Settings, …) still get initial focus moved into the dialog
  // and a saved `previouslyFocused` for restore-on-close. Without this, the
  // watcher only fires on change and focus stays behind the overlay.
  { immediate: true },
);

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown);
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown);
  // Release this dialog's slot if it unmounts while still open (e.g. the
  // parent v-if's it away before `open` flips to false).
  if (props.open) openDialogCount.value = Math.max(0, openDialogCount.value - 1);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ui-dialog__overlay" @mousedown="onOverlayClick">
      <div
        ref="panel"
        class="ui-dialog"
        :class="[`ui-dialog--${size}`, { 'ui-dialog--flush': !padded, 'ui-dialog--fixed-height': height === 'fixed' }]"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
      >
        <div v-if="title || $slots.head" class="ui-dialog__head">
          <slot name="head">
            <div class="ui-dialog__titles">
              <div v-if="title" class="ui-dialog__title">{{ title }}</div>
              <div v-if="description" class="ui-dialog__desc">{{ description }}</div>
            </div>
          </slot>
          <IconButton class="ui-dialog__close" size="sm" label="Close" @click="close">
            <Icon name="close" size="md" />
          </IconButton>
        </div>
        <div class="ui-dialog__body"><slot /></div>
        <div v-if="$slots.foot" class="ui-dialog__foot"><slot name="foot" /></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ui-dialog__overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  background: rgba(13, 17, 23, 0.45);
  animation: kimi-dialog-overlay-in var(--duration-base) var(--ease-out);
}
@keyframes kimi-dialog-overlay-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.ui-dialog {
  max-height: calc(100vh - var(--space-8) * 2);
  display: flex;
  flex-direction: column;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  outline: none;
  overflow: hidden;
  animation: kimi-card-in var(--duration-slow) var(--ease-out);
}
.ui-dialog--md { width: min(440px, 100%); }
.ui-dialog--lg { width: min(640px, 100%); }
.ui-dialog--xl { width: min(var(--p-content-max), 100%); }
.ui-dialog--fixed-height { height: min(680px, calc(100vh - var(--space-8) * 2)); }
.ui-dialog--flush .ui-dialog__body { padding: 0; }
.ui-dialog__head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 20px 22px 14px;
}
.ui-dialog__titles { flex: 1; min-width: 0; }
.ui-dialog__title {
  font-size: var(--text-lg);
  font-weight: 500;
  color: var(--color-text);
  line-height: var(--leading-tight);
}
.ui-dialog__desc { margin-top: 4px; font-size: var(--text-base); color: var(--color-text-muted); }
.ui-dialog__close { flex: none; margin-top: -2px; }
.ui-dialog__body { flex: 1; min-height: 0; padding: 4px 22px 18px; color: var(--color-text); overflow: auto; }
.ui-dialog__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 22px 20px;
}
</style>
