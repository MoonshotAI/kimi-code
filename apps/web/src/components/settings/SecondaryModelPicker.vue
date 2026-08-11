<!-- Linked model + thinking-effort picker for the secondary-model settings
     row: a cascading variant of the §03 Select pattern. The trigger opens a
     single-level model list (grouped by provider); hovering / activating a
     model row flies its effort submenu out to the right (flipping left near
     the viewport edge), so an effort is only ever picked for the model it
     belongs to (options follow the composer's thinking-level model: off +
     declared levels for effort models, on/off for boolean-thinking models,
     off alone for unsupported ones). Clicking an effort confirms the
     model+effort pair atomically (one POST /config patch). While no effort is
     set at all, a "模型默认" entry is offered first — it writes the model
     alone, letting the subagent fall back to the global thinking default.

     The menu teleports to <body> with position:fixed — it opens on top of the
     settings modal, and only a body-level surface escapes the dialog's
     scrolling-body clip (the sidebar column's container-type would also
     capture position:fixed, same reason UserMenu teleports). -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { segmentsFor, type ModelThinkingInfo } from '@moonshot-ai/app-core/lib';

export type SecondaryModelGroup = { provider: string; options: Array<{ id: string; label: string }> };

const props = defineProps<{
  /** Currently configured model alias; '' = unset (inherit primary). */
  modelValue: string;
  /** Currently configured thinking effort; '' = unset (model default). */
  effort: string;
  /** Model choices grouped by provider (same shape as the settings modelGroups). */
  groups: SecondaryModelGroup[];
  /** Thinking capability info per model id (catalog entry); ids missing here
      (config-only models) fall back to the boolean on/off toggle. */
  modelInfoById: Record<string, ModelThinkingInfo>;
}>();

const emit = defineEmits<{ select: [value: { model: string; effort?: string }] }>();

const { t } = useI18n();

/** Flyout width + gap budget used by the left/right flip check. */
const FLYOUT_WIDTH = 188;
/** Hover-intent grace before an abandoned flyout closes (mirrors UserMenu). */
const HOVER_CLOSE_DELAY = 250;
/** Viewport edge clearance for the fixed-position menu. */
const VIEWPORT_MARGIN = 8;

const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const modelRowRefs = new Map<string, HTMLElement>();
const open = ref(false);
// Set on open when the space below the trigger cannot fit the menu — it then
// opens upward (the Subagents section sits at the bottom of the Agent tab).
const flipUp = ref(false);
const menuStyle = ref<Record<string, string>>({});
const menuId = `sm-picker-${Math.random().toString(36).slice(2, 9)}`;

// The model highlighted in the list (keyboard) / whose flyout is up (hover).
const activeModelId = ref('');
const flyoutFor = ref<string | null>(null);
const flyoutDir = ref<'right' | 'left'>('right');
const flyoutTop = ref(0);
// Keyboard model (focus stays on the trigger, mirrors Select): which level
// the arrows drive, and the highlighted index within it.
const focusColumn = ref<'models' | 'efforts'>('models');
const activeModelIndex = ref(0);
const activeEffortIndex = ref(0);

let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

const flatModels = computed<Array<{ id: string; label: string }>>(() =>
  props.groups.flatMap((group) => group.options),
);

const modelLabel = computed(() => {
  if (!props.modelValue) return '';
  return flatModels.value.find((option) => option.id === props.modelValue)?.label ?? props.modelValue;
});

const displayText = computed(() => {
  if (!props.modelValue) return t('settings.noSecondaryModel');
  return props.effort ? `${modelLabel.value} · ${props.effort}` : modelLabel.value;
});

// Flyout options follow the composer's thinking-level model (`segmentsFor`):
// effort models get off + their declared levels (always-thinking ones get no
// off), boolean-thinking models get on/off, unsupported models get off alone.
// `null` = "模型默认" (write the model WITHOUT an effort, letting the subagent
// fall back to the global thinking config → model default) — only offered
// while no effort is set at all: POST /config merges and cannot clear a
// stored effort, so offering it afterwards would be a no-op that misleads.
// A configured effort the model does not declare (stale / env-written) is
// appended so the current pair stays visible and re-selectable.
const flyoutEfforts = computed<Array<string | null>>(() => {
  const id = flyoutFor.value;
  if (id === null) return [];
  const segments = segmentsFor(props.modelInfoById[id]);
  const efforts: Array<string | null> = props.effort === '' ? [null, ...segments] : [...segments];
  if (props.modelValue === id && props.effort !== '' && !segments.includes(props.effort)) {
    efforts.push(props.effort);
  }
  return efforts;
});

function isEffortSelected(effort: string | null): boolean {
  if (props.modelValue !== flyoutFor.value) return false;
  return effort === null ? props.effort === '' : props.effort === effort;
}

function effortScrollTarget(): number {
  const current = flyoutEfforts.value.findIndex((effort) => isEffortSelected(effort));
  return current >= 0 ? current : 0;
}

function setModelRowRef(el: unknown, id: string): void {
  if (el instanceof HTMLElement) modelRowRefs.set(id, el);
  else modelRowRefs.delete(id);
}

function cancelHoverClose(): void {
  if (hoverCloseTimer !== null) {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = null;
  }
}

function scheduleHoverClose(): void {
  cancelHoverClose();
  hoverCloseTimer = setTimeout(() => {
    flyoutFor.value = null;
    if (focusColumn.value === 'efforts') focusColumn.value = 'models';
  }, HOVER_CLOSE_DELAY);
}

function activateModel(id: string): void {
  if (id === activeModelId.value) return;
  activeModelId.value = id;
  activeModelIndex.value = Math.max(
    0,
    flatModels.value.findIndex((option) => option.id === id),
  );
}

// Re-anchors the fixed menu to the trigger (called on open and whenever the
// dialog body scrolls), flipping upward near the viewport bottom.
function positionMenu(): void {
  const trigger = triggerRef.value;
  const menu = menuRef.value;
  if (!trigger || !menu) return;
  const rect = trigger.getBoundingClientRect();
  const menuHeight = menu.offsetHeight;
  const spaceBelow = window.innerHeight - rect.bottom;
  flipUp.value = spaceBelow < menuHeight + VIEWPORT_MARGIN && rect.top > menuHeight;
  const right = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right);
  menuStyle.value = flipUp.value
    ? { right: `${right}px`, bottom: `${window.innerHeight - rect.top + 4}px`, top: 'auto' }
    : { right: `${right}px`, top: `${rect.bottom + 4}px`, bottom: 'auto' };
}

// Anchors the flyout to the row's CURRENT rendered position (recomputed on
// scroll so it stays glued to the row), opening to the right and flipping
// left near the viewport edge per the §03 menu anchoring rules.
function positionFlyout(): void {
  const menu = menuRef.value;
  const row = flyoutFor.value === null ? undefined : modelRowRefs.get(flyoutFor.value);
  if (!menu || !row) return;
  const menuRect = menu.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  flyoutTop.value = Math.max(0, Math.min(rowRect.top - menuRect.top - 4, menu.offsetHeight - 40));
  const spaceRight = window.innerWidth - menuRect.right;
  const spaceLeft = menuRect.left;
  flyoutDir.value = spaceRight >= FLYOUT_WIDTH || spaceRight >= spaceLeft ? 'right' : 'left';
}

function openFlyout(id: string, { moveFocus = false } = {}): void {
  activateModel(id);
  cancelHoverClose();
  flyoutFor.value = id;
  if (moveFocus) {
    focusColumn.value = 'efforts';
    activeEffortIndex.value = effortScrollTarget();
  }
  void nextTick(positionFlyout);
}

function closeFlyout(): void {
  flyoutFor.value = null;
  focusColumn.value = 'models';
}

function openMenu(): void {
  if (open.value) return;
  open.value = true;
  activeModelId.value = props.modelValue || (flatModels.value[0]?.id ?? '');
  activeModelIndex.value = Math.max(
    0,
    flatModels.value.findIndex((option) => option.id === activeModelId.value),
  );
  // Only the first level shows on open — the flyout appears on hover / arrow.
  flyoutFor.value = null;
  focusColumn.value = 'models';
  void nextTick(positionMenu);
}

function closeMenu({ restoreFocus = false } = {}): void {
  if (!open.value) return;
  cancelHoverClose();
  open.value = false;
  flyoutFor.value = null;
  if (restoreFocus) void nextTick(() => triggerRef.value?.focus());
}

function toggleMenu(): void {
  if (open.value) closeMenu();
  else openMenu();
}

function selectEffort(effort: string | null): void {
  if (flyoutFor.value === null) return;
  const next = { model: flyoutFor.value, effort: effort ?? undefined };
  if (next.model !== props.modelValue || (next.effort ?? '') !== props.effort) {
    emit('select', next);
  }
  closeMenu({ restoreFocus: true });
}

function scrollActiveIntoView(): void {
  void nextTick(() => {
    menuRef.value
      ?.querySelector('.sm-picker__option.is-kb-active')
      ?.scrollIntoView({ block: 'nearest' });
  });
}

function moveModel(delta: 1 | -1): void {
  const list = flatModels.value;
  if (list.length === 0) return;
  const index = (activeModelIndex.value + delta + list.length) % list.length;
  const id = list[index]!.id;
  activateModel(id);
  if (flyoutFor.value !== null) openFlyout(id);
  scrollActiveIntoView();
}

function moveEffort(delta: 1 | -1): void {
  const list = flyoutEfforts.value;
  if (list.length === 0) return;
  activeEffortIndex.value = (activeEffortIndex.value + delta + list.length) % list.length;
  scrollActiveIntoView();
}

function onKeydown(event: KeyboardEvent): void {
  if (!open.value) {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu();
    }
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (focusColumn.value === 'models') moveModel(1);
    else moveEffort(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (focusColumn.value === 'models') moveModel(-1);
    else moveEffort(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    openFlyout(activeModelId.value, { moveFocus: true });
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (flyoutFor.value !== null) closeFlyout();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (focusColumn.value === 'models') openFlyout(activeModelId.value, { moveFocus: true });
    else selectEffort(flyoutEfforts.value[activeEffortIndex.value] ?? null);
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const toFirst = event.key === 'Home';
    if (focusColumn.value === 'models') {
      const list = flatModels.value;
      if (list.length === 0) return;
      const id = (toFirst ? list[0] : list.at(-1))!.id;
      activateModel(id);
      if (flyoutFor.value !== null) openFlyout(id);
    } else {
      activeEffortIndex.value = toFirst ? 0 : flyoutEfforts.value.length - 1;
    }
    scrollActiveIntoView();
  } else if (event.key === 'Escape') {
    // preventDefault keeps the surrounding dialog's own Esc handling from
    // firing (same contract as the §03 Select).
    event.preventDefault();
    closeMenu({ restoreFocus: true });
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node;
  if (rootRef.value?.contains(target) || menuRef.value?.contains(target)) return;
  closeMenu();
}

// The menu is fixed-position: it does not follow the dialog's scrolling body
// on its own, so re-anchor on any outside scroll (column scrolls only need a
// flyout re-anchor); a window resize invalidates the anchoring entirely.
function onDocumentScroll(event: Event): void {
  if (!open.value) return;
  if (menuRef.value?.contains(event.target as Node)) {
    positionFlyout();
    return;
  }
  positionMenu();
  positionFlyout();
}

function onWindowResize(): void {
  closeMenu();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('scroll', onDocumentScroll, true);
  window.addEventListener('resize', onWindowResize);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('scroll', onDocumentScroll, true);
  window.removeEventListener('resize', onWindowResize);
  cancelHoverClose();
});
</script>

<template>
  <div ref="rootRef" class="sm-picker" :class="{ 'is-open': open }">
    <button
      ref="triggerRef"
      class="sm-picker__trigger"
      type="button"
      role="combobox"
      :aria-controls="menuId"
      :aria-expanded="open"
      aria-haspopup="dialog"
      :aria-label="t('settings.secondaryModel')"
      @click="toggleMenu"
      @keydown="onKeydown"
    >
      <span class="sm-picker__value" :class="{ 'is-placeholder': !modelValue }">
        <span class="sm-picker__value-text">{{ displayText }}</span>
      </span>
      <Icon class="sm-picker__chevron" name="chevron-down" size="sm" />
    </button>

    <!-- Teleport: opens above the settings modal; only a body-level surface
         escapes the dialog's scrolling-body clip. -->
    <Teleport to="body">
      <div
        v-if="open"
        :id="menuId"
        ref="menuRef"
        class="sm-picker__menu"
        :class="{ 'sm-picker__menu--up': flipUp }"
        :style="menuStyle"
        role="dialog"
        :aria-label="t('settings.secondaryModel')"
      >
        <div class="sm-picker__models" role="listbox" :aria-label="t('settings.secondaryModel')">
          <template v-for="group in groups" :key="group.provider">
            <div class="sm-picker__group">{{ group.provider }}</div>
            <button
              v-for="option in group.options"
              :key="option.id"
              :ref="(el) => setModelRowRef(el, option.id)"
              class="sm-picker__option"
              :class="{
                'is-selected': option.id === modelValue,
                'is-active': option.id === activeModelId,
                'is-kb-active': focusColumn === 'models' && option.id === activeModelId,
              }"
              type="button"
              role="option"
              :aria-selected="option.id === modelValue"
              @mouseenter="openFlyout(option.id)"
              @mouseleave="scheduleHoverClose"
              @click="openFlyout(option.id, { moveFocus: true })"
            >
              <Icon class="sm-picker__check" name="check" size="sm" />
              <span class="sm-picker__option-label">{{ option.label }}</span>
              <Icon class="sm-picker__flyout-caret" name="chevron-right" size="sm" />
            </button>
          </template>
        </div>

        <div
          v-if="flyoutFor !== null"
          class="sm-picker__flyout"
          :class="`sm-picker__flyout--${flyoutDir}`"
          :style="{ top: `${flyoutTop}px` }"
          role="listbox"
          :aria-label="t('settings.secondaryModelEffort')"
          @mouseenter="cancelHoverClose"
          @mouseleave="scheduleHoverClose"
        >
          <div class="sm-picker__group">{{ t('settings.secondaryModelEffort') }}</div>
          <button
            v-for="(effort, index) in flyoutEfforts"
            :key="effort ?? '__default__'"
            class="sm-picker__option"
            :class="{
              'is-selected': isEffortSelected(effort),
              'is-active': focusColumn === 'efforts' && index === activeEffortIndex,
              'is-kb-active': focusColumn === 'efforts' && index === activeEffortIndex,
              'is-muted': effort === null,
            }"
            type="button"
            role="option"
            :aria-selected="isEffortSelected(effort)"
            @mouseenter="focusColumn = 'efforts'; activeEffortIndex = index"
            @click="selectEffort(effort)"
          >
            <Icon class="sm-picker__check" name="check" size="sm" />
            <span class="sm-picker__option-label">{{ effort ?? t('settings.secondaryModelEffortAuto') }}</span>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sm-picker {
  position: relative;
  width: 100%;
  font-family: var(--font-ui);
}
.sm-picker__trigger {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  height: 38px;
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
.sm-picker__trigger:focus-visible,
.sm-picker.is-open .sm-picker__trigger {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: var(--p-focus-ring);
}
.sm-picker__value {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
}
.sm-picker__value-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sm-picker__value.is-placeholder { color: var(--color-text-faint); }
.sm-picker__chevron {
  flex: none;
  color: var(--color-text-muted);
  transition: transform var(--duration-base) var(--ease-out);
}
.sm-picker.is-open .sm-picker__chevron { transform: rotate(180deg); }

/* Teleported to <body>: opens above the settings modal, on the menu-above-
   modal rung of the elevation scale. */
.sm-picker__menu {
  position: fixed;
  z-index: var(--z-modal-dropdown);
  width: 252px;
  max-width: calc(100vw - 64px);
  border: 0.5px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  box-shadow: var(--shadow-lg);
}
.sm-picker__models {
  max-height: 280px;
  overflow-y: auto;
  padding: var(--space-1);
  border-radius: var(--radius-md);
}
.sm-picker__flyout {
  position: absolute;
  width: 180px;
  max-height: 280px;
  overflow-y: auto;
  padding: var(--space-1);
  border: 0.5px solid var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  box-shadow: var(--shadow-lg);
}
.sm-picker__flyout--right { left: calc(100% + var(--space-1)); }
.sm-picker__flyout--left { right: calc(100% + var(--space-1)); }
.sm-picker__group {
  padding: var(--space-2) var(--space-2) var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}
.sm-picker__option {
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
.sm-picker__option.is-active { background: var(--color-hover); color: var(--color-text-strong); }
.sm-picker__option.is-muted { color: var(--color-text-muted); }
.sm-picker__option-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sm-picker__check { flex: none; color: transparent; }
.sm-picker__option.is-selected .sm-picker__check { color: var(--color-accent); }
.sm-picker__flyout-caret {
  flex: none;
  margin-left: auto;
  color: var(--color-text-faint);
}
</style>
