<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Menu } from '@moonshot-ai/app-ui';
import { effortLabel, providerDisplayName, segmentsFor, type ModelThinkingInfo } from '@moonshot-ai/app-core/lib';

export type SecondaryModelGroup = { provider: string; options: Array<{ id: string; label: string }> };

const props = defineProps<{
  modelValue: string;
  effort: string;
  groups: SecondaryModelGroup[];
  modelInfoById: Record<string, ModelThinkingInfo>;
}>();

const emit = defineEmits<{ select: [value: { model: string | null; effort?: string }] }>();

const { t } = useI18n();

const FOLLOW_DEFAULT_MODEL_ID = '';
const FLYOUT_WIDTH = 188;
const HOVER_CLOSE_DELAY = 250;
const VIEWPORT_MARGIN = 8;

const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuSurfaceRef = ref<InstanceType<typeof Menu> | null>(null);
const flyoutSurfaceRef = ref<InstanceType<typeof Menu> | null>(null);
const menuRef = computed(() => menuSurfaceRef.value?.el ?? null);
const flyoutRef = computed(() => flyoutSurfaceRef.value?.el ?? null);
const modelRowRefs = new Map<string, HTMLElement>();
const open = ref(false);
const flipUp = ref(false);
const menuStyle = ref<Record<string, string>>({});
const menuId = `sm-picker-${Math.random().toString(36).slice(2, 9)}`;

const activeModelId = ref('');
const flyoutFor = ref<string | null>(null);
const flyoutDir = ref<'right' | 'left'>('right');
const flyoutTop = ref(0);
const focusColumn = ref<'models' | 'efforts'>('models');
const activeModelIndex = ref(0);
const activeEffortIndex = ref(0);

let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

const flatModels = computed<Array<{ id: string; label: string }>>(() =>
  props.groups.flatMap((group) => group.options),
);
const modelIds = computed(() => [
  FOLLOW_DEFAULT_MODEL_ID,
  ...flatModels.value.map((option) => option.id),
]);

const modelLabel = computed(() => {
  if (!props.modelValue) return '';
  return flatModels.value.find((option) => option.id === props.modelValue)?.label ?? props.modelValue;
});

const displayText = computed(() => {
  if (!props.modelValue) return t('settings.noSecondaryModel');
  return props.effort ? `${modelLabel.value} · ${effortLabel(props.effort)}` : modelLabel.value;
});

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
  activeModelIndex.value = Math.max(0, modelIds.value.indexOf(id));
}

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

function positionFlyout(): void {
  const menu = menuRef.value;
  const row = flyoutFor.value === null ? undefined : modelRowRefs.get(flyoutFor.value);
  if (!menu || !row) return;
  const menuRect = menu.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const flyoutHeight = flyoutRef.value?.offsetHeight ?? 0;
  const maxTop = Math.max(0, window.innerHeight - VIEWPORT_MARGIN - flyoutHeight - menuRect.top);
  flyoutTop.value = Math.max(
    0,
    Math.min(rowRect.top - menuRect.top - 4, menu.offsetHeight - 40, maxTop),
  );
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
  activeModelId.value = props.modelValue;
  activeModelIndex.value = Math.max(0, modelIds.value.indexOf(activeModelId.value));
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

function selectFollowDefault(): void {
  emit('select', { model: null });
  closeMenu({ restoreFocus: true });
}

function hoverFollowDefault(): void {
  activateModel(FOLLOW_DEFAULT_MODEL_ID);
  cancelHoverClose();
  closeFlyout();
}

function scrollActiveIntoView(): void {
  void nextTick(() => {
    menuRef.value
      ?.querySelector('.sm-picker__option.is-kb-active')
      ?.scrollIntoView({ block: 'nearest' });
  });
}

function moveModel(delta: 1 | -1): void {
  const list = modelIds.value;
  if (list.length === 0) return;
  const index = (activeModelIndex.value + delta + list.length) % list.length;
  const id = list[index]!;
  activateModel(id);
  if (flyoutFor.value !== null) {
    if (id === FOLLOW_DEFAULT_MODEL_ID) closeFlyout();
    else openFlyout(id);
  }
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
    if (activeModelId.value !== FOLLOW_DEFAULT_MODEL_ID) {
      openFlyout(activeModelId.value, { moveFocus: true });
    }
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (flyoutFor.value !== null) closeFlyout();
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (focusColumn.value === 'models') {
      if (activeModelId.value === FOLLOW_DEFAULT_MODEL_ID) selectFollowDefault();
      else openFlyout(activeModelId.value, { moveFocus: true });
    } else {
      selectEffort(flyoutEfforts.value[activeEffortIndex.value] ?? null);
    }
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const toFirst = event.key === 'Home';
    if (focusColumn.value === 'models') {
      const list = modelIds.value;
      if (list.length === 0) return;
      const id = (toFirst ? list[0] : list.at(-1))!;
      activateModel(id);
      if (flyoutFor.value !== null) {
        if (id === FOLLOW_DEFAULT_MODEL_ID) closeFlyout();
        else openFlyout(id);
      }
    } else {
      activeEffortIndex.value = toFirst ? 0 : flyoutEfforts.value.length - 1;
    }
    scrollActiveIntoView();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu({ restoreFocus: true });
  }
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node;
  if (rootRef.value?.contains(target) || menuRef.value?.contains(target)) return;
  closeMenu();
}

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

    <Teleport to="body">
      <Menu
        v-if="open"
        :id="menuId"
        ref="menuSurfaceRef"
        class="sm-picker__menu"
        :class="{ 'sm-picker__menu--up': flipUp }"
        :style="menuStyle"
        role="dialog"
        :aria-label="t('settings.secondaryModel')"
      >
        <div class="sm-picker__models" role="listbox" :aria-label="t('settings.secondaryModel')">
          <button
            class="sm-picker__option"
            :class="{
              'is-selected': !modelValue,
              'is-active': activeModelId === FOLLOW_DEFAULT_MODEL_ID,
              'is-kb-active': focusColumn === 'models' && activeModelId === FOLLOW_DEFAULT_MODEL_ID,
            }"
            type="button"
            role="option"
            :aria-selected="!modelValue"
            @mouseenter="hoverFollowDefault"
            @mouseleave="scheduleHoverClose"
            @click="selectFollowDefault"
          >
            <Icon class="sm-picker__check" name="check" size="sm" />
            <span class="sm-picker__option-label">{{ t('settings.noSecondaryModel') }}</span>
          </button>
          <template v-for="group in groups" :key="group.provider">
            <div class="sm-picker__group">{{ providerDisplayName(group.provider, t) }}</div>
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

        <Menu
          v-if="flyoutFor !== null"
          ref="flyoutSurfaceRef"
          class="sm-picker__flyout"
          :class="`sm-picker__flyout--${flyoutDir}`"
          :style="{ top: `${flyoutTop}px` }"
          role="listbox"
          :register="false"
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
            <span class="sm-picker__option-label">{{ effort === null ? t('settings.secondaryModelEffortAuto') : effortLabel(effort) }}</span>
          </button>
        </Menu>
      </Menu>
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
  border: var(--p-hairline) solid var(--color-line-strong);
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

.sm-picker__menu {
  position: fixed;
  z-index: var(--z-modal-dropdown);
  width: 252px;
  max-width: calc(100vw - 64px);
}
.sm-picker__menu.ui-menu { padding: 0; }
.sm-picker__models {
  max-height: 280px;
  overflow-y: auto;
  padding: var(--menu-pad);
  border-radius: inherit;
}
.sm-picker__flyout {
  position: absolute;
  width: 180px;
  max-height: 280px;
  overflow-y: auto;
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
  border-radius: var(--radius-select-option);
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
