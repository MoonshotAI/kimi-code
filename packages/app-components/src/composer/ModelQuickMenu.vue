<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppModel } from '@moonshot-ai/app-core/api';
import { commitLevel, effectiveThinkingLevel, effortLabel, modelThinkingAvailability, providerDisplayName, segmentsFor } from '@moonshot-ai/app-core/lib';
import { searchModelsForMenu, type ModelSearchTextRange } from '@moonshot-ai/app-client/lib';
import { Icon, useImeComposition } from '@moonshot-ai/app-ui';
import ModelCapabilityInfo from './ModelCapabilityInfo.vue';
import {
  MODEL_MENU_ROW_HEIGHT,
  MODEL_MENU_WIDTH,
  SEARCH_MENU_MAX_ITEMS,
  computeAnchoredFlyoutPosition,
} from './modelMenuLayout';

interface ProviderOption {
  id: string;
  label: string;
}

type SubmenuState =
  | { kind: 'provider'; triggerKey: string }
  | { kind: 'effort'; triggerKey: string }
  | { kind: 'search-effort'; triggerKey: string; model: AppModel };

interface NavRow {
  key: string;
  kind: 'model' | 'provider' | 'effort';
  model?: AppModel;
  disabled?: boolean;
  hasSubmenu: boolean;
}

const props = defineProps<{
  models: AppModel[];
  recentModels: AppModel[];
  providerModels: AppModel[];
  providers: ProviderOption[];
  activeProvider: string;
  activeProviderLabel: string;
  currentModelId?: string;
  currentEffort?: string;
  effortDescriptions?: Record<string, string>;
  maxHeight: number;
  hostFrame?: { x: number; y: number; viewportWidth: number; viewportHeight: number };
}>();

const emit = defineEmits<{
  selectModel: [modelId: string, effort?: string, fromSearch?: boolean];
  selectEffort: [effort: string];
  selectProvider: [providerId: string];
  dismiss: [];
}>();

const { t } = useI18n();
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

const rootEl = ref<HTMLElement>();
const searchInputEl = ref<HTMLInputElement>();
const flyoutEl = ref<HTMLElement>();
const rowElements = new Map<string, HTMLElement>();
const query = ref('');
const activeKey = ref('');
const submenu = ref<SubmenuState | null>(null);
const submenuIndex = ref(0);
const hoverModel = ref<{ key: string; model: AppModel } | null>(null);
const flyoutStyle = ref<Record<string, string>>({});
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let submenuTimer: ReturnType<typeof setTimeout> | undefined;

const searching = computed(() => query.value.trim().length > 0);
const currentModel = computed(() => props.models.find((model) => model.id === props.currentModelId));
const currentAvailability = computed(() => modelThinkingAvailability(currentModel.value));
const currentSegments = computed(() => segmentsFor(currentModel.value));
const currentEffortValue = computed(() => effectiveThinkingLevel(currentModel.value, props.currentEffort));
const effortExpandable = computed(
  () => currentAvailability.value !== 'unsupported' && currentSegments.value.length > 1,
);
const effortValueLabel = computed(() => {
  if (currentAvailability.value === 'unsupported') return t('status.thinkingUnsupported');
  return effortLabel(currentSegments.value.includes(currentEffortValue.value) ? currentEffortValue.value : currentSegments.value[0] ?? 'off');
});

const searchResults = computed(() =>
  searchModelsForMenu(props.models, query.value, (provider) => providerDisplayName(provider, t)).slice(0, SEARCH_MENU_MAX_ITEMS),
);

function supportsThinkingSubmenu(model: AppModel): boolean {
  return modelThinkingAvailability(model) !== 'unsupported' && segmentsFor(model).length > 0;
}

const navRows = computed<NavRow[]>(() => {
  if (searching.value) {
    return searchResults.value.map((entry) => ({
      key: `search:${entry.model.id}`,
      kind: 'model',
      model: entry.model,
      hasSubmenu: supportsThinkingSubmenu(entry.model),
    }));
  }
  const rows: NavRow[] = props.recentModels.map((model) => ({
    key: `recent:${model.id}`,
    kind: 'model',
    model,
    hasSubmenu: false,
  }));
  for (const model of props.providerModels) {
    rows.push({ key: `provider:${model.id}`, kind: 'model', model, hasSubmenu: false });
  }
  if (props.providers.length > 0) {
    rows.push({ key: 'action:provider', kind: 'provider', hasSubmenu: true });
  }
  rows.push({
    key: 'action:effort',
    kind: 'effort',
    disabled: !effortExpandable.value,
    hasSubmenu: effortExpandable.value,
  });
  return rows;
});

const activeSubmenuModel = computed(() => (submenu.value?.kind === 'search-effort' ? submenu.value.model : undefined));
const activeSubmenuSegments = computed(() => {
  if (submenu.value?.kind === 'effort') return currentSegments.value;
  if (submenu.value?.kind === 'search-effort') return segmentsFor(submenu.value.model);
  return [];
});
const submenuOptionsCount = computed(() => {
  if (submenu.value?.kind === 'provider') return props.providers.length;
  return activeSubmenuSegments.value.length;
});
const thinkingDescription = computed(() => {
  if (submenu.value?.kind === 'effort') {
    const highlighted = activeSubmenuSegments.value[submenuIndex.value];
    if (highlighted !== undefined) {
      const cloud = props.effortDescriptions?.[highlighted];
      if (cloud !== undefined) return cloud;
    }
  }
  return t('status.thinkingDesc');
});

function setRowElement(key: string) {
  return (el: unknown): void => {
    if (el instanceof HTMLElement) rowElements.set(key, el);
    else rowElements.delete(key);
  };
}

function clearHoverTimer(): void {
  if (hoverTimer !== undefined) clearTimeout(hoverTimer);
  hoverTimer = undefined;
}

function clearSubmenuTimer(): void {
  if (submenuTimer !== undefined) clearTimeout(submenuTimer);
  submenuTimer = undefined;
}

function hideHoverCard(): void {
  clearHoverTimer();
  hoverModel.value = null;
}

function scheduleHoverCard(key: string, model: AppModel): void {
  clearHoverTimer();
  hoverModel.value = null;
  hoverTimer = setTimeout(() => {
    if (submenu.value === null && activeKey.value === key) {
      hoverModel.value = { key, model };
    }
  }, 500);
}

function openSubmenu(next: SubmenuState): void {
  clearSubmenuTimer();
  hideHoverCard();
  const changed = submenu.value?.kind !== next.kind || submenu.value.triggerKey !== next.triggerKey;
  submenu.value = next;
  if (changed && next.kind === 'effort') {
    const currentIndex = currentSegments.value.indexOf(currentEffortValue.value);
    submenuIndex.value = currentIndex >= 0 ? currentIndex : 0;
  } else if (changed) {
    submenuIndex.value = 0;
  }
}

function closeSubmenu(): void {
  clearSubmenuTimer();
  submenu.value = null;
}

function onRowEnter(row: NavRow): void {
  activeKey.value = row.key;
  clearSubmenuTimer();
  hideHoverCard();
  if (row.disabled) {
    closeSubmenu();
    return;
  }
  if (row.kind === 'provider') {
    submenuTimer = setTimeout(() => openSubmenu({ kind: 'provider', triggerKey: row.key }), 80);
    return;
  }
  if (row.kind === 'effort' && row.hasSubmenu) {
    submenuTimer = setTimeout(() => openSubmenu({ kind: 'effort', triggerKey: row.key }), 80);
    return;
  }
  if (row.model !== undefined && searching.value && row.hasSubmenu) {
    const model = row.model;
    submenuTimer = setTimeout(() => openSubmenu({ kind: 'search-effort', triggerKey: row.key, model }), 80);
    return;
  }
  closeSubmenu();
  if (row.model !== undefined) scheduleHoverCard(row.key, row.model);
}

function onRowLeave(): void {
  clearSubmenuTimer();
  hideHoverCard();
}

function onRowClick(row: NavRow): void {
  if (row.disabled) return;
  activeKey.value = row.key;
  hideHoverCard();
  if (row.kind === 'provider') {
    if (submenu.value?.kind === 'provider') closeSubmenu();
    else openSubmenu({ kind: 'provider', triggerKey: row.key });
    return;
  }
  if (row.kind === 'effort') {
    if (submenu.value?.kind === 'effort') closeSubmenu();
    else openSubmenu({ kind: 'effort', triggerKey: row.key });
    return;
  }
  if (row.model === undefined) return;
  if (searching.value) {
    if (row.hasSubmenu) openSubmenu({ kind: 'search-effort', triggerKey: row.key, model: row.model });
    else selectSearchedModel(row.model);
    return;
  }
  emit('selectModel', row.model.id);
}

function chooseProvider(providerId: string): void {
  closeSubmenu();
  emit('selectProvider', providerId);
}

function selectSearchedModel(model: AppModel, effort?: string): void {
  closeSubmenu();
  hideHoverCard();
  query.value = '';
  void nextTick(() => {
    const providerKey = `provider:${model.id}`;
    const recentKey = `recent:${model.id}`;
    const nextKey = rowElements.has(providerKey) ? providerKey : rowElements.has(recentKey) ? recentKey : undefined;
    if (nextKey === undefined) return;
    activeKey.value = nextKey;
    rowElements.get(nextKey)?.scrollIntoView({ block: 'nearest' });
  });
  emit('selectModel', model.id, effort, true);
}

function chooseSubmenuEffort(segment: string): void {
  const current = submenu.value;
  if (current?.kind === 'search-effort') {
    selectSearchedModel(current.model, commitLevel(current.model, segment));
  } else {
    closeSubmenu();
    emit('selectEffort', segment);
  }
}

function moveActive(delta: number): void {
  const rows = navRows.value.filter((row) => !row.disabled);
  if (rows.length === 0) return;
  hideHoverCard();
  const index = rows.findIndex((row) => row.key === activeKey.value);
  const nextIndex = index === -1 ? (delta > 0 ? 0 : rows.length - 1) : (index + delta + rows.length) % rows.length;
  const next = rows[nextIndex]!;
  activeKey.value = next.key;
  if (submenu.value !== null) {
    if (next.kind === 'provider') openSubmenu({ kind: 'provider', triggerKey: next.key });
    else if (next.kind === 'effort' && next.hasSubmenu) openSubmenu({ kind: 'effort', triggerKey: next.key });
    else if (next.model !== undefined && searching.value && next.hasSubmenu) {
      openSubmenu({ kind: 'search-effort', triggerKey: next.key, model: next.model });
    } else closeSubmenu();
  }
  void nextTick(() => {
    rowElements.get(next.key)?.scrollIntoView({ block: 'nearest' });
  });
}

function activateCurrentRow(): void {
  const row = navRows.value.find((candidate) => candidate.key === activeKey.value) ?? navRows.value.find((candidate) => !candidate.disabled);
  if (row !== undefined) onRowClick(row);
}

function onKeydown(event: KeyboardEvent): void {
  if (isComposingKeyEvent(event)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (submenu.value !== null) closeSubmenu();
    else emit('dismiss');
    return;
  }
  if (submenu.value !== null) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const count = submenuOptionsCount.value;
      if (count > 0) submenuIndex.value = (submenuIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      closeSubmenu();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const current = submenu.value;
      if (current.kind === 'provider') {
        const provider = props.providers[submenuIndex.value];
        if (provider !== undefined) chooseProvider(provider.id);
      } else {
        const segment = activeSubmenuSegments.value[submenuIndex.value];
        if (segment !== undefined) chooseSubmenuEffort(segment);
      }
      return;
    }
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveActive(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (event.key === 'ArrowRight') {
    const row = navRows.value.find((candidate) => candidate.key === activeKey.value);
    if (row?.hasSubmenu && !row.disabled) {
      event.preventDefault();
      onRowClick(row);
    }
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    activateCurrentRow();
    return;
  }
  if (
    event.key.length === 1 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    document.activeElement !== searchInputEl.value
  ) {
    searchInputEl.value?.focus();
  }
}

function highlightParts(text: string, ranges: readonly ModelSearchTextRange[]): { text: string; matched: boolean }[] {
  if (ranges.length === 0) return [{ text, matched: false }];
  const parts: { text: string; matched: boolean }[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), matched: false });
    parts.push({ text: text.slice(range.start, range.end), matched: true });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), matched: false });
  return parts;
}

function syncFlyoutPosition(): void {
  const triggerKey = submenu.value?.triggerKey ?? hoverModel.value?.key;
  const menu = rootEl.value;
  const flyout = flyoutEl.value;
  if (triggerKey === undefined || menu === undefined || flyout === undefined) return;
  const trigger = rowElements.get(triggerKey);
  if (trigger === undefined) return;
  const menuRect = menu.getBoundingClientRect();
  const triggerRect = trigger.getBoundingClientRect();
  const flyoutRect = flyout.getBoundingClientRect();
  const firstOption = submenu.value !== null ? flyout.querySelector<HTMLElement>('[data-first-option]') : null;
  const firstOptionOffset =
    firstOption === null ? 0 : firstOption.getBoundingClientRect().top - flyoutRect.top;
  const frame = props.hostFrame;
  const position = computeAnchoredFlyoutPosition({
    menuLeft: frame?.x ?? menuRect.left,
    menuTop: frame?.y ?? menuRect.top,
    menuWidth: menuRect.width || MODEL_MENU_WIDTH,
    triggerTop: triggerRect.top - menuRect.top,
    triggerHeight: triggerRect.height || MODEL_MENU_ROW_HEIGHT,
    flyoutWidth: flyoutRect.width || MODEL_MENU_WIDTH,
    flyoutHeight: flyoutRect.height,
    firstOptionOffset,
    viewportWidth: frame?.viewportWidth ?? window.innerWidth,
    viewportHeight: frame?.viewportHeight ?? window.innerHeight,
  });
  flyoutStyle.value = {
    top: `${Math.round(position.top * 100) / 100}px`,
    ...(position.side === 'right' ? { left: 'calc(100% + 4px)', right: 'auto' } : { right: 'calc(100% + 4px)', left: 'auto' }),
  };
}

watch([submenu, hoverModel], () => {
  flyoutStyle.value = { visibility: 'hidden' };
  void nextTick(syncFlyoutPosition);
});

watch(query, () => {
  closeSubmenu();
  hideHoverCard();
  activeKey.value = navRows.value[0]?.key ?? '';
});

onMounted(() => {
  const current = navRows.value.find(
    (row) => row.key === `provider:${props.currentModelId}` || row.key === `recent:${props.currentModelId}`,
  );
  activeKey.value = (current ?? navRows.value.find((row) => !row.disabled))?.key ?? '';
});

onUnmounted(() => {
  clearHoverTimer();
  clearSubmenuTimer();
});

defineExpose({
  el: rootEl,
  focusSearch: () => searchInputEl.value?.focus(),
});
</script>

<template>
  <div
    ref="rootEl"
    class="mqm"
    role="menu"
    aria-orientation="vertical"
    :style="{ maxHeight: `${props.maxHeight}px` }"
    tabindex="-1"
    @keydown="onKeydown"
    @scroll="hideHoverCard"
  >
    <div class="mqm-scroll">
      <template v-if="searching">
        <div v-if="searchResults.length > 0" class="mqm-label">{{ t('status.searchResults') }}</div>
        <template v-if="searchResults.length > 0">
          <div
            v-for="entry in searchResults"
            :key="entry.model.id"
            :ref="setRowElement(`search:${entry.model.id}`)"
            class="mqm-row"
            :class="{
              'is-active': activeKey === `search:${entry.model.id}`,
              'is-provider-match': entry.matchedProvider,
            }"
            role="menuitem"
            :data-row-key="`search:${entry.model.id}`"
            @mouseenter="onRowEnter({ key: `search:${entry.model.id}`, kind: 'model', model: entry.model, hasSubmenu: supportsThinkingSubmenu(entry.model) })"
            @mouseleave="onRowLeave"
            @click="onRowClick({ key: `search:${entry.model.id}`, kind: 'model', model: entry.model, hasSubmenu: supportsThinkingSubmenu(entry.model) })"
          >
            <span class="mqm-name">
              <template v-for="(part, index) in highlightParts(entry.modelName, entry.modelRanges)" :key="index"><span v-if="part.matched" class="mqm-match">{{ part.text }}</span><template v-else>{{ part.text }}</template></template>
            </span>
            <span class="mqm-provider">
              <template v-for="(part, index) in highlightParts(entry.providerName, entry.providerRanges)" :key="index"><span v-if="part.matched" class="mqm-match">{{ part.text }}</span><template v-else>{{ part.text }}</template></template>
            </span>
            <Icon v-if="supportsThinkingSubmenu(entry.model)" name="chevron-right" size="sm" class="mqm-trailing-icon" />
          </div>
        </template>
        <div v-else class="mqm-row mqm-empty" role="note">{{ t('status.noMatchingModels') }}</div>
      </template>

      <template v-else>
        <div v-if="props.recentModels.length > 0" class="mqm-section">
          <div class="mqm-label">{{ t('status.recentModels') }}</div>
          <div
            v-for="model in props.recentModels"
            :key="`recent:${model.id}`"
            :ref="setRowElement(`recent:${model.id}`)"
            class="mqm-row"
            :class="{ 'is-active': activeKey === `recent:${model.id}` }"
            role="menuitemradio"
            :aria-checked="model.id === props.currentModelId"
            :data-row-key="`recent:${model.id}`"
            @mouseenter="onRowEnter({ key: `recent:${model.id}`, kind: 'model', model, hasSubmenu: false })"
            @mouseleave="onRowLeave"
            @click="onRowClick({ key: `recent:${model.id}`, kind: 'model', model, hasSubmenu: false })"
          >
            <span class="mqm-name">{{ model.displayName ?? model.model }}</span>
            <span class="mqm-provider">{{ providerDisplayName(model.provider, t) }}</span>
            <Icon v-if="model.id === props.currentModelId" name="check" size="sm" class="mqm-trailing-icon" />
          </div>
        </div>

        <div v-if="props.recentModels.length > 0" class="mqm-divider" />

        <div v-if="props.providerModels.length > 0 || props.activeProvider" class="mqm-section">
          <div class="mqm-label">{{ props.activeProviderLabel }}</div>
          <div
            v-for="model in props.providerModels"
            :key="`provider:${model.id}`"
            :ref="setRowElement(`provider:${model.id}`)"
            class="mqm-row"
            :class="{ 'is-active': activeKey === `provider:${model.id}` }"
            role="menuitemradio"
            :aria-checked="model.id === props.currentModelId"
            :data-row-key="`provider:${model.id}`"
            @mouseenter="onRowEnter({ key: `provider:${model.id}`, kind: 'model', model, hasSubmenu: false })"
            @mouseleave="onRowLeave"
            @click="onRowClick({ key: `provider:${model.id}`, kind: 'model', model, hasSubmenu: false })"
          >
            <span class="mqm-name">{{ model.displayName ?? model.model }}</span>
            <Icon v-if="model.id === props.currentModelId" name="check" size="sm" class="mqm-trailing-icon" />
          </div>
        </div>
      </template>
    </div>

    <template v-if="!searching">
      <div class="mqm-divider" />

      <div class="mqm-actions">
        <div
          v-if="props.providers.length > 0"
          :ref="setRowElement('action:provider')"
          class="mqm-row"
          :class="{ 'is-active': activeKey === 'action:provider' }"
          role="menuitem"
          aria-haspopup="menu"
          :aria-expanded="submenu?.kind === 'provider'"
          data-row-key="action:provider"
          @mouseenter="onRowEnter({ key: 'action:provider', kind: 'provider', hasSubmenu: true })"
          @mouseleave="onRowLeave"
          @click="onRowClick({ key: 'action:provider', kind: 'provider', hasSubmenu: true })"
        >
          <span class="mqm-action-label">{{ t('status.switchProvider') }}</span>
          <span class="mqm-action-value">{{ props.activeProviderLabel }}</span>
          <Icon name="chevron-right" size="sm" class="mqm-trailing-icon" />
        </div>
        <div
          :ref="setRowElement('action:effort')"
          class="mqm-row"
          :class="{ 'is-active': activeKey === 'action:effort', 'is-disabled': !effortExpandable }"
          role="menuitem"
          :aria-haspopup="effortExpandable ? 'menu' : undefined"
          :aria-expanded="effortExpandable ? submenu?.kind === 'effort' : undefined"
          :aria-disabled="!effortExpandable"
          data-row-key="action:effort"
          @mouseenter="onRowEnter({ key: 'action:effort', kind: 'effort', disabled: !effortExpandable, hasSubmenu: effortExpandable })"
          @mouseleave="onRowLeave"
          @click="onRowClick({ key: 'action:effort', kind: 'effort', disabled: !effortExpandable, hasSubmenu: effortExpandable })"
        >
          <span class="mqm-action-label">{{ t('status.statusThinking') }}</span>
          <span class="mqm-action-value">{{ effortValueLabel }}</span>
          <Icon v-if="effortExpandable" name="chevron-right" size="sm" class="mqm-trailing-icon" />
        </div>
      </div>
    </template>

    <div class="mqm-divider" />

    <div class="mqm-search">
      <Icon name="search" size="md" class="mqm-search__icon" />
      <input
        ref="searchInputEl"
        v-model="query"
        class="mqm-search__input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        :placeholder="t('status.searchModels')"
        :aria-label="t('status.searchModels')"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
      />
    </div>

    <div
      v-if="submenu !== null"
      ref="flyoutEl"
      class="mqm-flyout"
      role="menu"
      :style="flyoutStyle"
      @mouseenter="clearSubmenuTimer"
    >
      <template v-if="submenu.kind === 'provider'">
        <div class="mqm-label">{{ t('status.providerLabel') }}</div>
        <div class="mqm-submenu-scroll">
          <div
            v-for="(provider, index) in props.providers"
            :key="provider.id"
            class="mqm-row"
            :class="{ 'is-active': submenuIndex === index }"
            role="menuitemradio"
            :aria-checked="provider.id === props.activeProvider"
            :data-first-option="index === 0 ? '' : undefined"
            @mouseenter="submenuIndex = index"
            @click="chooseProvider(provider.id)"
          >
            <span class="mqm-solo-name" :title="provider.label">{{ provider.label }}</span>
            <Icon v-if="provider.id === props.activeProvider" name="check" size="sm" class="mqm-trailing-icon" />
          </div>
        </div>
      </template>

      <template v-else-if="submenu.kind === 'effort'">
        <div class="mqm-thinking-desc">{{ thinkingDescription }}</div>
        <div class="mqm-submenu-scroll">
          <div
            v-for="(segment, index) in activeSubmenuSegments"
            :key="segment"
            class="mqm-row"
            :class="{ 'is-active': submenuIndex === index }"
            role="menuitemradio"
            :aria-checked="segment === currentEffortValue"
            :data-first-option="index === 0 ? '' : undefined"
            @mouseenter="submenuIndex = index"
            @click="chooseSubmenuEffort(segment)"
          >
            <span class="mqm-solo-name">{{ effortLabel(segment) }}</span>
            <Icon v-if="segment === currentEffortValue" name="check" size="sm" class="mqm-trailing-icon" />
          </div>
        </div>
      </template>

      <template v-else-if="activeSubmenuModel !== undefined">
        <div class="mqm-flyout-model-info">
          <ModelCapabilityInfo :model="activeSubmenuModel" />
        </div>
        <div class="mqm-divider" />
        <div class="mqm-label">{{ t('status.statusThinking') }}</div>
        <div class="mqm-submenu-scroll">
          <div
            v-for="(segment, index) in activeSubmenuSegments"
            :key="segment"
            class="mqm-row"
            :class="{ 'is-active': submenuIndex === index }"
            role="menuitemradio"
            :aria-checked="activeSubmenuModel.id === props.currentModelId && segment === currentEffortValue"
            :data-first-option="index === 0 ? '' : undefined"
            @mouseenter="submenuIndex = index"
            @click="chooseSubmenuEffort(segment)"
          >
            <span class="mqm-solo-name">{{ effortLabel(segment) }}</span>
            <Icon
              v-if="activeSubmenuModel.id === props.currentModelId && segment === currentEffortValue"
              name="check"
              size="sm"
              class="mqm-trailing-icon"
            />
          </div>
        </div>
      </template>
    </div>

    <div
      v-else-if="hoverModel !== null"
      ref="flyoutEl"
      class="mqm-flyout mqm-hover-card"
      role="tooltip"
      :style="flyoutStyle"
    >
      <ModelCapabilityInfo :model="hoverModel.model" />
    </div>
  </div>
</template>

<style scoped>
.mqm {
  --mqm-row-height: calc(32px + var(--ui-shift) * 2);
  --mqm-label-height: calc(28px + var(--ui-shift) * 2);
  position: relative;
  display: flex;
  flex-direction: column;
  width: 240px;
  padding: 4px;
  overflow: visible;
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: 12px;
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-menu);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  outline: none;
  box-sizing: border-box;
}
.mqm-scroll {
  flex: 0 1 auto;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
}
.mqm-section {
  flex: none;
}
.mqm-actions {
  flex: none;
}
.mqm-label {
  display: flex;
  align-items: center;
  height: var(--mqm-label-height);
  padding: 0 8px;
  overflow: hidden;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: calc(18px + var(--ui-shift));
  text-overflow: ellipsis;
  white-space: nowrap;
  box-sizing: border-box;
}
.mqm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--mqm-row-height);
  padding: 0 8px;
  border-radius: 8px;
  font-size: var(--text-sm);
  line-height: calc(18px + var(--ui-shift));
  white-space: nowrap;
  cursor: pointer;
  box-sizing: border-box;
  user-select: none;
}
.mqm-row.is-active {
  background: var(--color-hover);
}
.mqm-row.is-disabled {
  cursor: default;
}
.mqm-row.is-disabled .mqm-action-label {
  color: var(--color-text-muted);
}
.mqm-empty {
  color: var(--color-text-faint);
  cursor: default;
}
.mqm-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  text-overflow: ellipsis;
}
.mqm-provider {
  flex: 0 100000 auto;
  min-width: 64px;
  overflow: hidden;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
}
.mqm-row:not(:has(.mqm-provider)) .mqm-name,
.mqm-solo-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  text-overflow: ellipsis;
}
.mqm-row.is-provider-match .mqm-provider {
  flex: 0 0 auto;
  min-width: 0;
  max-width: 96px;
}
.mqm-action-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  text-overflow: ellipsis;
}
.mqm-action-value {
  flex: 0 0 auto;
  max-width: 96px;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
}
.mqm-trailing-icon {
  flex: none;
  color: var(--color-text-muted);
}
.mqm-match {
  color: var(--color-accent);
}
.mqm-divider {
  flex: none;
  padding: 4px 8px;
}
.mqm-divider::after {
  content: '';
  display: block;
  width: 100%;
  height: var(--p-hairline);
  background: var(--color-line);
}
.mqm-search {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: var(--mqm-row-height);
  padding: 0 8px;
  box-sizing: border-box;
}
.mqm-search__icon {
  flex: none;
  color: var(--color-text-faint);
}
.mqm-search__input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--text-sm);
  line-height: calc(18px + var(--ui-shift));
}
.mqm-search__input::placeholder {
  color: var(--color-text-faint);
}
.mqm-flyout {
  position: absolute;
  z-index: 2;
  display: flex;
  flex-direction: column;
  width: 240px;
  padding: 4px;
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: 12px;
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-menu);
  box-sizing: border-box;
}
.mqm-hover-card {
  padding: 12px;
  pointer-events: none;
}
.mqm-thinking-desc {
  padding: 6px 8px;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: calc(18px + var(--ui-shift));
}
.mqm-flyout-model-info {
  padding: 8px;
}
.mqm-submenu-scroll {
  max-height: 256px;
  overflow-y: auto;
  scrollbar-width: thin;
}
</style>
