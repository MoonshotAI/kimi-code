<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { Icon, trackMenuSurface } from '@moonshot-ai/app-ui';

const props = defineProps<{
  label: string;
  popup: 'menu' | 'dialog';
  panelLabel: string;
  chipClass: string;
  panelClass: string;
  panelWidth?: number;
}>();

const emit = defineEmits<{
  panelKeydown: [event: KeyboardEvent];
}>();

const open = defineModel<boolean>('open', { default: false });

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;
const ALIGN_MARGIN = 16;

const anchorRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const up = ref(false);
const alignRight = ref(false);
const maxHeight = ref<number | null>(null);
trackMenuSurface(open, panelRef);

function place(): void {
  const el = anchorRef.value;
  if (el === null) return;
  const rect = el.getBoundingClientRect();
  const port = el.closest('.panes')?.getBoundingClientRect();
  const top = port?.top ?? 0;
  const bottom = port?.bottom ?? window.innerHeight;
  const below = bottom - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
  const above = rect.top - top - ANCHOR_GAP - VIEWPORT_MARGIN;
  up.value = below < 200 && above > below;
  const available = Math.floor(up.value ? above : below);
  maxHeight.value = available > 0 ? available : null;
  const width = props.panelWidth;
  alignRight.value =
    width !== undefined && rect.left + width > window.innerWidth - ALIGN_MARGIN && rect.right >= width;
}

function onPointerDown(event: MouseEvent): void {
  const target = event.target as Node | null;
  if (target === null) return;
  if (anchorRef.value?.contains(target)) return;
  close();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  event.preventDefault();
  event.stopPropagation();
  close({ focusTrigger: true });
}

function listen(active: boolean): void {
  if (typeof document === 'undefined') return;
  document.removeEventListener('mousedown', onPointerDown, true);
  document.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', place);
  if (!active) return;
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', place);
}

watch(open, (isOpen) => listen(isOpen));
onScopeDispose(() => listen(false));

function toggle(): void {
  if (open.value) {
    close();
    return;
  }
  place();
  open.value = true;
}

function close(options?: { focusTrigger?: boolean }): void {
  if (!open.value) return;
  open.value = false;
  if (options?.focusTrigger === true) triggerRef.value?.focus();
}

function focusPanel(): void {
  panelRef.value?.focus({ preventScroll: true });
}

defineExpose({ close, focusPanel });
</script>

<template>
  <div ref="anchorRef" data-create-picker>
    <button
      ref="triggerRef"
      type="button"
      class="cp-chip"
      :class="[chipClass, { open }]"
      :aria-haspopup="popup"
      :aria-expanded="open"
      :aria-label="label"
      @click.stop="toggle"
    >
      <slot name="chip" />
      <Icon class="cp-chip-chev" name="chevron-down" size="sm" />
    </button>
    <slot name="extra" />
    <div
      v-if="open"
      ref="panelRef"
      class="cp-panel"
      :class="[panelClass, { up, 'align-right': alignRight }]"
      :style="maxHeight === null ? undefined : { maxHeight: `${maxHeight}px` }"
      :role="popup"
      tabindex="-1"
      :aria-label="panelLabel"
      @keydown="emit('panelKeydown', $event)"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
[data-create-picker] {
  position: relative;
  display: flex;
  font-family: var(--font-ui);
}
.cp-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-width: 0;
  height: 28px;
  margin-bottom: 4px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: 10px;
  background: var(--color-selected);
  -webkit-backdrop-filter: blur(30px);
  backdrop-filter: blur(30px);
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--ui-font-size-sm);
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--duration-base) var(--ease-out);
}
.cp-chip:hover,
.cp-chip.open {
  color: var(--color-text-strong);
}
.cp-chip:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.cp-chip-chev {
  flex: none;
  transition: transform var(--duration-base) var(--ease-out);
}
.cp-chip.open .cp-chip-chev {
  transform: rotate(180deg);
}
.cp-panel {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  z-index: var(--z-dropdown);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: var(--space-1);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  box-shadow: var(--shadow-sm);
  animation: cp-pop var(--duration-base) var(--ease-out);
}
:slotted(.cp-row) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-dropdown-row);
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
:slotted(.cp-row.active) {
  background: var(--color-hover);
}
:slotted(.cp-row.on) {
  background: var(--color-selected);
}
.cp-panel:focus {
  outline: none;
}
.cp-panel.align-right {
  right: 0;
  left: auto;
}
.cp-panel.up {
  top: auto;
  bottom: calc(100% + var(--space-1));
}
@keyframes cp-pop {
  from {
    opacity: 0;
    transform: scale(0.99);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
