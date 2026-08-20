<!-- Design-system §03 Select: custom trigger + listbox, with the selected
     option centred in the scrollable menu when it opens.

     The listbox teleports to <body> with position:fixed — it opens on top of
     modal dialogs (settings), and only a body-level surface escapes a
     scrolling container's clip (the same recipe as SecondaryModelPicker /
     UserMenu). It opens toward the roomier side of the trigger, shrinking
     its max-height to fit when neither side has room, and re-anchors on
     residual scroll / window resize. While open, scroll gestures outside
     the menu are swallowed so the surface behind cannot scroll — a touch
     gesture that dismisses the menu stays locked until it ends — and the
     menu closes when focus leaves the trigger ↔ menu loop. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useAttrs, watch } from 'vue';
import Icon from './Icon.vue';
import { computeSelectMenuLayout, shouldBlockBehindScroll } from '../../lib/selectMenu';
import { trackMenuSurface } from '../../composables/menuStack';

defineOptions({ inheritAttrs: false });

type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
  /** Optional leading icon (image URL), shown in the trigger and the option row. */
  icon?: string;
};

const props = withDefaults(defineProps<{
  modelValue?: string | number;
  options: SelectOption[];
  placeholder?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  error?: boolean;
}>(), {
  placeholder: '',
  size: 'md',
});

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const attrs = useAttrs();
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const optionRefs = ref<Array<HTMLElement | null>>([]);
const open = ref(false);
const activeIndex = ref(-1);
const listboxId = `ui-select-${Math.random().toString(36).slice(2, 9)}`;
const menuStyle = ref<Record<string, string>>({});

// While the listbox is up it is a menu surface: tooltips outside it hide
// (native menu behavior) — see TooltipBubble / menuStack.
trackMenuSurface(open, listRef);

/** Fallbacks for the --space-1 / --space-2 derived geometry when a token
    can't be read (non-token host, parse failure). */
const MENU_GAP_FALLBACK = 4;
const VIEWPORT_MARGIN_FALLBACK = 8;

/** The non-passive wheel/touchmove scroll lock is currently attached. */
let scrollLockAttached = false;
/** A pointer gesture that began while the menu was open is still down. */
let gestureLock = false;
/** The in-flight pointer gesture started inside the menu (scrollbar drag). */
let gestureInMenu = false;

// Trigger ↔ menu gap and viewport margin, read from the spacing tokens on
// each open so a token change can't drift from the anchoring.
let menuGap = MENU_GAP_FALLBACK;
let viewportMargin = VIEWPORT_MARGIN_FALLBACK;

function readSpacePx(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) ? px : fallback;
}

const selectedIndex = computed(() =>
  props.options.findIndex((option) => String(option.value) === String(props.modelValue ?? '')),
);
const selectedOption = computed(() => props.options[selectedIndex.value]);
const displayLabel = computed(() => selectedOption.value?.label ?? props.placeholder);

function setOptionRef(el: unknown, index: number): void {
  optionRefs.value[index] = el instanceof HTMLElement ? el : null;
}

function centerActiveOption(): void {
  const list = listRef.value;
  const option = optionRefs.value[activeIndex.value];
  if (!list || !option) return;
  list.scrollTop = option.offsetTop - (list.clientHeight - option.offsetHeight) / 2;
}

// Re-anchors the fixed menu to the trigger (called on open and whenever a
// residual scroll / window resize could have moved the trigger); the layout
// helper picks the roomier side and shrinks max-height when neither fits.
function positionMenu(): void {
  const trigger = triggerRef.value;
  const menu = listRef.value;
  if (!trigger || !menu) return;
  // Measure the NATURAL height: a maxHeight clamped by a previous anchor
  // would shrink offsetHeight and make this pass believe the menu fits.
  // (Vue re-applies the new style object on the next flush, before paint.)
  menu.style.maxHeight = '';
  const rect = trigger.getBoundingClientRect();
  menuStyle.value = computeSelectMenuLayout({
    anchor: rect,
    menuHeight: menu.offsetHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    gap: menuGap,
    margin: viewportMargin,
  }).style;
}

function openMenu(): void {
  if (props.disabled || open.value) return;
  open.value = true;
  activeIndex.value = selectedIndex.value >= 0
    ? selectedIndex.value
    : props.options.findIndex((option) => !option.disabled);
  menuGap = readSpacePx('--space-1', MENU_GAP_FALLBACK);
  viewportMargin = readSpacePx('--space-2', VIEWPORT_MARGIN_FALLBACK);
  addScrollLock();
  void nextTick(() => {
    positionMenu();
    // Center after the NEXT flush: positionMenu only staged menuStyle —
    // clientHeight still reflects the unclamped height until Vue applies a
    // possible max-height clamp, and the scroll math needs the final one.
    void nextTick(centerActiveOption);
  });
}

function closeMenu({ restoreFocus = false } = {}): void {
  if (!open.value) return;
  open.value = false;
  maybeRemoveScrollLock();
  if (restoreFocus) void nextTick(() => triggerRef.value?.focus());
}

function toggleMenu(): void {
  if (open.value) closeMenu();
  else openMenu();
}

function selectOption(option: SelectOption): void {
  if (option.disabled) return;
  if (String(option.value) !== String(props.modelValue ?? '')) {
    emit('update:modelValue', option.value);
  }
  closeMenu({ restoreFocus: true });
}

function moveActive(delta: 1 | -1): void {
  if (!open.value) openMenu();
  if (props.options.length === 0) return;
  let index = activeIndex.value;
  for (let step = 0; step < props.options.length; step += 1) {
    index = (index + delta + props.options.length) % props.options.length;
    if (!props.options[index]?.disabled) {
      activeIndex.value = index;
      void nextTick(centerActiveOption);
      return;
    }
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveActive(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveActive(-1);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (!open.value) openMenu();
    else {
      const option = props.options[activeIndex.value];
      if (option) selectOption(option);
    }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
  } else if (event.key === 'Tab') {
    // Let focus move on (no preventDefault), but don't strand the open menu —
    // it teleports to <body> and would outlive the focus change (e.g. Tabbing
    // across v-show'd settings tabs).
    closeMenu();
  } else if (event.key === 'PageUp' || event.key === 'PageDown') {
    // While open these would otherwise bubble up and scroll the surface
    // behind the floating menu (the trigger keeps focus).
    if (open.value) event.preventDefault();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const indexes = props.options
      .map((option, index) => option.disabled ? -1 : index)
      .filter((index) => index >= 0);
    activeIndex.value = event.key === 'Home' ? (indexes[0] ?? -1) : (indexes.at(-1) ?? -1);
    void nextTick(centerActiveOption);
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  // A pointer gesture that BEGINS while the menu is open keeps the scroll
  // lock until it ends (pointerup/cancel): the outside press that dismisses
  // the menu must not let the same touch drag scroll the surface behind.
  // Reassigned (not OR-ed) so a fresh gesture after a missed pointerup
  // self-heals the lock.
  gestureLock = open.value;
  const target = event.target as Node;
  if (rootRef.value?.contains(target) || listRef.value?.contains(target)) return;
  closeMenu();
}

function onDocumentPointerUp(): void {
  const wasInMenu = gestureInMenu;
  gestureLock = false;
  gestureInMenu = false;
  maybeRemoveScrollLock();
  // A gesture that started inside the menu (scrollbar drag, padding/group
  // press) blurred the trigger without moving DOM focus; with the gesture
  // over, hand focus back so Esc/Tab reach the component again and the menu
  // doesn't strand holding the scroll lock. Normal option picks already
  // closed the menu and restored focus themselves (open is false → skip).
  if (wasInMenu && open.value) triggerRef.value?.focus();
}

// Track pointer gestures that START inside the menu: pressing the menu's
// scrollbar or padding blurs the trigger (focusout with relatedTarget
// null) without moving DOM focus — the deferred focusout check below uses
// this to tell that case apart from a real focus departure. (No
// preventDefault here: the scrollbar drag IS the pointerdown's default.)
function onMenuPointerDown(): void {
  gestureInMenu = true;
}

// Close when focus leaves the component for good (Tab away, clicking into
// another field): focus within the trigger ↔ menu loop keeps it open.
function onFocusOut(event: FocusEvent): void {
  const to = event.relatedTarget;
  if (to instanceof Node && (rootRef.value?.contains(to) || listRef.value?.contains(to))) return;
  // Defer the verdict past the focus/pointer churn: a scrollbar press lands
  // here with relatedTarget null and activeElement already on <body>, but
  // the menu must survive the drag.
  requestAnimationFrame(() => {
    if (!open.value || gestureInMenu) return;
    const active = document.activeElement;
    if (active && (rootRef.value?.contains(active) || listRef.value?.contains(active))) return;
    closeMenu();
  });
}

// The menu is fixed-position and scroll gestures outside it are swallowed
// while open; any scroll that still happens (scrollbar drag, programmatic)
// moves the trigger, so re-anchor instead of letting the two drift apart.
// The menu's own scrolling needs no re-anchor.
function onDocumentScroll(event: Event): void {
  if (!open.value) return;
  if (listRef.value?.contains(event.target as Node)) return;
  positionMenu();
}

function onWindowResize(): void {
  if (open.value) positionMenu();
}

// Options can grow while the menu is open (async load — e.g. the Archived
// tab's workspace filter filling in once its request settles): re-measure,
// re-flip and re-clamp against the new natural height, or the fresh options
// overflow the viewport. Deliberately no re-centering — yanking the scroll
// position while the user is browsing would be worse.
watch(
  () => props.options.length,
  () => {
    if (!open.value) return;
    void nextTick(positionMenu);
  },
);

// Scroll lock: while the listbox floats above the page, wheel / touch
// gestures outside it must not scroll the surface behind (the settings
// dialog's body). Capture + non-passive so preventDefault wins over any
// scroll container; the menu's own scroll gestures pass through.
function onWheelOrTouch(event: Event): void {
  // The gesture lock only extends TOUCH sequences past the close (a mouse
  // press-then-wheel is not a stuck gesture we need to outlast).
  const locked = event.type === 'touchmove' ? open.value || gestureLock : open.value;
  if (!locked) return;
  if (shouldBlockBehindScroll(event.target, listRef.value)) event.preventDefault();
}

// The non-passive scroll-lock listeners are attached ONLY while needed —
// while attached, every wheel/touch gesture on the page is forced onto the
// main thread, so a resident set per Select instance would tax every page
// that renders a few of them.
function addScrollLock(): void {
  if (scrollLockAttached) return;
  scrollLockAttached = true;
  document.addEventListener('wheel', onWheelOrTouch, { capture: true, passive: false });
  document.addEventListener('touchmove', onWheelOrTouch, { capture: true, passive: false });
}

function removeScrollLock(): void {
  if (!scrollLockAttached) return;
  scrollLockAttached = false;
  document.removeEventListener('wheel', onWheelOrTouch, { capture: true });
  document.removeEventListener('touchmove', onWheelOrTouch, { capture: true });
}

function maybeRemoveScrollLock(): void {
  if (open.value || gestureLock) return;
  removeScrollLock();
}

onMounted(() => {
  // All permanent listeners are passive / non-cancelable — nothing this
  // component keeps registered while closed may force scroll gestures onto
  // the main thread (the non-passive scroll lock attaches on open only).
  document.addEventListener('pointerdown', onDocumentPointerDown, { passive: true });
  document.addEventListener('pointerup', onDocumentPointerUp, { passive: true });
  document.addEventListener('pointercancel', onDocumentPointerUp, { passive: true });
  document.addEventListener('scroll', onDocumentScroll, true);
  window.addEventListener('resize', onWindowResize);
});
onUnmounted(() => {
  gestureLock = false;
  // Unconditional: maybeRemoveScrollLock would bail on open.value === true,
  // stranding the non-passive listeners (with listRef gone they'd block
  // every scroll gesture on the page) when a parent unmounts us mid-open.
  removeScrollLock();
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('pointerup', onDocumentPointerUp);
  document.removeEventListener('pointercancel', onDocumentPointerUp);
  document.removeEventListener('scroll', onDocumentScroll, true);
  window.removeEventListener('resize', onWindowResize);
});
</script>

<template>
  <div
    ref="rootRef"
    class="ui-select"
    :class="[`ui-select--${size}`, { 'has-error': error, 'is-open': open, 'is-disabled': disabled }]"
  >
    <button
      ref="triggerRef"
      v-bind="attrs"
      class="ui-select__trigger"
      type="button"
      role="combobox"
      :aria-controls="listboxId"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :disabled="disabled"
      @click="toggleMenu"
      @keydown="onKeydown"
      @focusout="onFocusOut"
    >
      <span class="ui-select__value" :class="{ 'is-placeholder': !selectedOption }">
        <img v-if="selectedOption?.icon" class="ui-select__icon" :src="selectedOption.icon" alt="" />
        <span class="ui-select__value-text">{{ displayLabel }}</span>
      </span>
      <Icon class="ui-select__chevron" name="chevron-down" size="sm" />
    </button>

    <!-- Teleport: opens above modal dialogs; only a body-level surface
         escapes a scrolling container's clip (same recipe as
         SecondaryModelPicker). Scoped styles still apply — the data-v
         attribute travels with the teleported node. -->
    <Teleport to="body">
      <div
        v-if="open"
        :id="listboxId"
        ref="listRef"
        class="ui-select__menu"
        :style="menuStyle"
        role="listbox"
        @pointerdown="onMenuPointerDown"
        @focusout="onFocusOut"
      >
        <template v-for="(option, index) in options" :key="`${option.group ?? ''}:${option.value}`">
          <div
            v-if="option.group && option.group !== options[index - 1]?.group"
            class="ui-select__group"
          >
            {{ option.group }}
          </div>
          <button
            :ref="(el) => setOptionRef(el, index)"
            class="ui-select__option"
            :class="{ 'is-selected': index === selectedIndex, 'is-active': index === activeIndex }"
            type="button"
            role="option"
            :aria-selected="index === selectedIndex"
            :disabled="option.disabled"
            @mouseenter="activeIndex = index"
            @click="selectOption(option)"
          >
            <Icon class="ui-select__check" name="check" size="sm" />
            <img v-if="option.icon" class="ui-select__icon ui-select__icon--option" :src="option.icon" alt="" />
            <span>{{ option.label }}</span>
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.ui-select {
  position: relative;
  width: 100%;
  font-family: var(--font-ui);
}
.ui-select__trigger {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: 100%;
  padding: 0 var(--space-3);
  border: 0.5px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: transparent;
  box-shadow: none;
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out),
    background var(--duration-base) var(--ease-out);
}
.ui-select--md { height: 38px; }
.ui-select--sm { height: 32px; }
.ui-select--sm .ui-select__trigger { font-size: var(--text-sm); }
.ui-select__trigger:hover:not(:disabled) { border-color: var(--color-line-strong); }
.ui-select__trigger:focus-visible,
.ui-select.is-open .ui-select__trigger {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: var(--p-focus-ring);
}
.ui-select.has-error .ui-select__trigger { border-color: var(--color-danger); }
.ui-select.has-error .ui-select__trigger:focus-visible { box-shadow: 0 0 0 3px var(--color-danger-soft); }
.ui-select__value {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  overflow: hidden;
  white-space: nowrap;
}
.ui-select__value-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ui-select__value.is-placeholder { color: var(--color-text-faint); }
.ui-select__icon { flex: none; width: 14px; height: 14px; border-radius: 3px; }
.ui-select__icon--option { width: 16px; height: 16px; border-radius: 4px; }
.ui-select__chevron {
  flex: none;
  color: var(--color-text-muted);
  transition: transform var(--duration-base) var(--ease-out);
}
.ui-select.is-open .ui-select__chevron { transform: rotate(180deg); }
.ui-select.is-disabled { opacity: 0.5; }
.ui-select.is-disabled .ui-select__trigger { cursor: not-allowed; }
/* Teleported to <body>: position:fixed + inline top/bottom/left/width anchor
   it to the trigger; the z rung is the menu-above-modal one so the listbox
   floats over the settings dialog. */
.ui-select__menu {
  position: fixed;
  z-index: var(--z-modal-dropdown);
  max-height: 260px;
  overflow-y: auto;
  /* A wheel gesture that reaches the menu's own scroll end must not chain
     into the surface behind it. */
  overscroll-behavior: contain;
  padding: var(--space-1);
  border: 0.5px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  box-shadow: var(--shadow-lg);
}
.ui-select__group {
  padding: var(--space-2) var(--space-2) var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}
.ui-select__option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 32px;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}
.ui-select__option.is-active { background: var(--color-hover); color: var(--color-text-strong); }
.ui-select__option:disabled { opacity: 0.45; cursor: not-allowed; }
.ui-select__check { flex: none; color: transparent; }
.ui-select__option.is-selected .ui-select__check { color: var(--color-accent); }
</style>
