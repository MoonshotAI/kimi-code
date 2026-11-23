<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type StyleValue } from 'vue';
import { useKimiI18n } from '@moonshot-ai/app-i18n';
import { pushDialog, removeDialog, topDialogId } from '../../composables/dialogStack';
import IconButton from './IconButton.vue';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{
  open: boolean;
  title?: string;
  ariaLabel?: string;
  description?: string;
  closeOnOverlay?: boolean;
  closeOnEsc?: boolean;
  forwardEsc?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  panelClass?: string;
  panelStyle?: StyleValue;
  height?: 'auto' | 'fixed';
  padded?: boolean;
  hideClose?: boolean;
  level?: 'raised' | 'grouped';
  initialFocus?: HTMLElement | string | (() => HTMLElement | null | undefined);
  focusOnOpen?: boolean;
}>(), {
  closeOnOverlay: true,
  closeOnEsc: true,
  size: 'md',
  height: 'auto',
  padded: true,
  level: 'raised',
  focusOnOpen: true,
});

const emit = defineEmits<{
  'update:open': [value: boolean];
  close: [];
}>();

const { t } = useKimiI18n();

const panel = ref<HTMLElement | null>(null);
let previouslyFocused: Element | null = null;

const dialogId = Symbol('kimi-dialog');
const isTop = computed(() => topDialogId.value === dialogId);

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function close() {
  emit('update:open', false);
  emit('close');
}

function focusables(): HTMLElement[] {
  return panel.value ? Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
}

function resolveInitialFocus(): HTMLElement | null {
  const { initialFocus } = props;
  if (!initialFocus) return null;
  if (typeof initialFocus === 'function') {
    return initialFocus() ?? null;
  }
  if (typeof initialFocus === 'string') {
    return panel.value?.querySelector<HTMLElement>(initialFocus) ?? null;
  }
  return panel.value?.contains(initialFocus) ? initialFocus : null;
}

function onKeydown(event: KeyboardEvent) {
  if (!props.open || !isTop.value) return;
  if (event.key === 'Escape') {
    if (props.forwardEsc) return;
    event.preventDefault();
    event.stopPropagation();
    if (props.closeOnEsc) close();
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
      pushDialog(dialogId);
      previouslyFocused = document.activeElement;
      if (props.focusOnOpen) {
        await nextTick();
        const initial = resolveInitialFocus();
        const list = focusables();
        (initial ?? list[0] ?? panel.value)?.focus();
      }
    } else {
      removeDialog(dialogId);
      if (previouslyFocused instanceof HTMLElement) {
        await nextTick();
        previouslyFocused.focus();
        previouslyFocused = null;
      }
    }
  },
  { immediate: true },
);

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown);
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown);
  if (props.open) {
    removeDialog(dialogId);
    if (previouslyFocused instanceof HTMLElement) {
      const restoreTo = previouslyFocused;
      void nextTick(() => restoreTo.focus());
    }
  }
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ui-dialog__overlay" @mousedown="onOverlayClick">
      <div
        ref="panel"
        class="ui-dialog"
        :class="[`ui-dialog--${size}`, panelClass, { 'ui-dialog--flush': !padded, 'ui-dialog--fixed-height': height === 'fixed', 'ui-dialog--grouped': level === 'grouped' }]"
        :style="panelStyle"
        role="dialog"
        :aria-modal="isTop"
        :aria-label="ariaLabel ?? title"
        :inert="!isTop"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <div v-if="title || $slots.head" class="ui-dialog__head">
          <slot name="head">
            <div class="ui-dialog__titles">
              <div v-if="title" class="ui-dialog__title">{{ title }}</div>
              <div v-if="description" class="ui-dialog__desc">{{ description }}</div>
            </div>
          </slot>
          <IconButton v-if="!hideClose" class="ui-dialog__close" size="sm" :label="t('common.close')" :tooltip="t('common.close')" @click="close">
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
  background: rgba(13, 17, 23, 0.28);
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
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  outline: none;
  overflow: hidden;
  animation: kimi-card-in var(--duration-slow) var(--ease-out);
}
.ui-dialog--sm { width: min(360px, 100%); }
.ui-dialog--md { width: min(440px, 100%); }
.ui-dialog--lg { width: min(640px, 100%); }
.ui-dialog--xl { width: min(880px, 100%); }
.ui-dialog--fixed-height { height: min(680px, calc(100vh - var(--space-8) * 2)); }
.ui-dialog--grouped { background: var(--color-bg); }
.ui-dialog--flush .ui-dialog__body { padding: 0; }
.ui-dialog__head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: 20px var(--dialog-pad-x) 14px;
}
.ui-dialog__titles { flex: 1; min-width: 0; }
.ui-dialog__title {
  font-size: var(--text-lg);
  font-weight: 500;
  color: var(--color-text);
  line-height: var(--leading-tight);
  overflow-wrap: anywhere;
}
.ui-dialog__desc { margin-top: 4px; font-size: var(--text-base); color: var(--color-text-muted); }
.ui-dialog__close { flex: none; margin-top: -2px; }
.ui-dialog__body { flex: 1; min-height: 0; padding: 4px var(--dialog-pad-x) 18px; color: var(--color-text); overflow: auto; }
.ui-dialog__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px var(--dialog-pad-x) var(--dialog-pad-x);
}

@media (max-width: 640px) {
  .ui-dialog__overlay {
    align-items: flex-end;
    padding: 0;
    top: var(--app-top, 0px);
    bottom: auto;
    height: 100vh;
    height: 100dvh;
    height: var(--app-height, 100dvh);
  }
  .ui-dialog {
    width: 100%;
    max-width: 100%;
    max-height: calc(var(--app-height, 100dvh) * 0.86);
    border-right: none;
    border-bottom: none;
    border-left: none;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    padding-bottom: var(--safe-bottom, 0px);
    animation: ui-dialog-sheet-up var(--duration-slow) var(--ease-out);
  }
  .ui-dialog--fixed-height {
    height: calc(var(--app-height, 100dvh) * 0.86);
  }
}
@keyframes ui-dialog-sheet-up {
  from { transform: translateY(101%); }
  to { transform: translateY(0); }
}
</style>
