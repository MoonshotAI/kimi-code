<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { Icon, Menu } from '@moonshot-ai/app-ui';

const props = defineProps<{
  label: string;
  popup: 'menu' | 'dialog';
  panelLabel: string;
  chipClass: string;
  panelClass: string;
  panelWidth?: number;
  activeDescendant?: string;
}>();

const emit = defineEmits<{
  panelKeydown: [event: KeyboardEvent];
}>();

const open = defineModel<boolean>('open', { default: false });

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;
const ALIGN_MARGIN = 16;

const anchorRef = ref<HTMLElement | null>(null);
const panelRef = ref<InstanceType<typeof Menu> | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const up = ref(false);
const alignRight = ref(false);
const maxHeight = ref<number | null>(null);
const panelStyle = computed(() => ({
  maxHeight: maxHeight.value === null ? undefined : `${maxHeight.value}px`,
  transformOrigin: `${up.value ? 'bottom' : 'top'} ${alignRight.value ? 'right' : 'left'}`,
  '--menu-pop-shift': up.value ? 'var(--space-05)' : undefined,
}));

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
  panelRef.value?.el?.focus({ preventScroll: true });
}

defineExpose({ close, focusPanel });
</script>

<template>
  <div ref="anchorRef" data-create-picker>
    <button
      ref="triggerRef"
      type="button"
      class="chip-trigger cp-chip"
      :class="[chipClass, { open }]"
      :aria-haspopup="popup"
      :aria-expanded="open"
      :aria-label="label"
      @click.stop="toggle"
    >
      <slot name="chip" />
      <Icon class="chip-trigger-chev" name="chevron-down" size="sm" />
    </button>
    <slot name="extra" />
    <Transition name="ui-menu-pop">
      <Menu
        v-if="open"
        ref="panelRef"
        class="cp-panel"
        :class="[panelClass, { up, 'align-right': alignRight }]"
        :style="panelStyle"
        :role="popup"
        tabindex="-1"
        :aria-label="panelLabel"
        :aria-activedescendant="activeDescendant"
        @keydown="emit('panelKeydown', $event)"
      >
        <slot />
      </Menu>
    </Transition>
  </div>
</template>

<style scoped src="../lib/chip-trigger.css"></style>
<style scoped>
[data-create-picker] {
  position: relative;
  display: flex;
  font-family: var(--font-ui);
}
.cp-chip {
  min-width: 0;
  white-space: nowrap;
}
.cp-panel {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  z-index: var(--z-dropdown);
  box-sizing: border-box;
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
</style>
