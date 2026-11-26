<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppModel } from '@moonshot-ai/app-core/api';
import type { QuickModelMenuPayload } from '@moonshot-ai/app-core/quick-model-menu';
import { commitLevel, effectiveThinkingLevel, effortLabel, modelThinkingAvailability, providerDisplayName, segmentsFor } from '@moonshot-ai/app-core/lib';
import { modelCapabilityItems, searchModelsForMenu } from '@moonshot-ai/app-client/lib';
import { Icon, useImeComposition } from '@moonshot-ai/app-ui';
import BottomSheet from '../dialogs/BottomSheet.vue';
import ModelMenuScrollThumb from './ModelMenuScrollThumb.vue';
import { SEARCH_MENU_MAX_ITEMS } from './modelMenuLayout';
import { highlightSearchText, modelCapabilityText, supportsThinkingSubmenu, type QuickModelMenuEmits } from './modelMenuShared';
import { useModelMenuScrollbar } from './useModelMenuScrollbar';

type SheetPage = 'main' | 'provider' | 'effort' | 'detail';

const props = defineProps<{
  modelValue: boolean;
  payload: () => QuickModelMenuPayload;
}>();

const emit = defineEmits<
  QuickModelMenuEmits & {
    'update:modelValue': [open: boolean];
  }
>();

const { t } = useI18n();
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

const sheetRef = ref<InstanceType<typeof BottomSheet>>();
const scrollEl = ref<HTMLElement>();
const listScrollbar = useModelMenuScrollbar(scrollEl);
const searchInputEl = ref<HTMLInputElement>();
const searchFocused = ref(false);
const query = ref('');
const page = ref<SheetPage>('main');
const detailModel = ref<AppModel>();
const detailFromSearch = ref(false);
const providerRowEl = ref<HTMLElement>();
const rowElements = new Map<string, HTMLElement>();
let longPressTimer: ReturnType<typeof setTimeout> | undefined;
let pressStartX = 0;
let pressStartY = 0;
let suppressRowClick = false;
let pendingRevealModelId: string | undefined;

const menu = computed(() => props.payload());
const searching = computed(() => query.value.trim().length > 0);
const currentModel = computed(() => menu.value.models.find((model) => model.id === menu.value.currentModelId));
const currentAvailability = computed(() => modelThinkingAvailability(currentModel.value));
const currentSegments = computed(() => segmentsFor(currentModel.value));
const currentEffortValue = computed(() => effectiveThinkingLevel(currentModel.value, menu.value.currentEffort));
const effortExpandable = computed(
  () => currentAvailability.value !== 'unsupported' && currentSegments.value.length > 1,
);
const effortValueLabel = computed(() => {
  if (currentAvailability.value === 'unsupported') return t('status.thinkingUnsupported');
  const level = currentSegments.value.includes(currentEffortValue.value) ? currentEffortValue.value : currentSegments.value[0] ?? 'off';
  return effortLabel(level);
});
const thinkingDescription = computed(
  () => menu.value.effortDescriptions?.[currentEffortValue.value] ?? t('status.thinkingDesc'),
);

const searchResults = computed(() =>
  searchModelsForMenu(menu.value.models, query.value, (provider) => providerDisplayName(provider, t)).slice(0, SEARCH_MENU_MAX_ITEMS),
);

const detailCapabilities = computed(() => (detailModel.value ? modelCapabilityItems(detailModel.value) : []));
const detailSegments = computed(() => (detailModel.value ? segmentsFor(detailModel.value) : []));

const sheetTitle = computed(() => {
  if (page.value === 'provider') return t('status.switchProvider');
  if (page.value === 'effort') return t('status.statusThinking');
  if (page.value === 'detail') return detailModel.value?.displayName ?? detailModel.value?.model ?? '';
  return t('status.switchModel');
});

function setRowElement(key: string) {
  return (el: unknown): void => {
    if (el instanceof HTMLElement) rowElements.set(key, el);
    else rowElements.delete(key);
  };
}

function scrollRowWithinSheet(row: HTMLElement, align: 'center' | 'nearest'): void {
  const body = scrollEl.value;
  if (!body || !body.contains(row)) return;
  const rowTop = row.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
  const rowBottom = rowTop + row.offsetHeight;
  if (align === 'center') {
    body.scrollTop = Math.max(0, rowTop - (body.clientHeight - row.offsetHeight) / 2);
    return;
  }
  if (rowTop < body.scrollTop) body.scrollTop = rowTop;
  else if (rowBottom > body.scrollTop + body.clientHeight) body.scrollTop = rowBottom - body.clientHeight;
}

function revealStagedModel(modelId: string): void {
  const key = rowElements.has(`provider:${modelId}`) ? `provider:${modelId}` : `recent:${modelId}`;
  const row = rowElements.get(key);
  if (row) scrollRowWithinSheet(row, 'nearest');
}

function transitionSheetHeight(fromHeight: number): void {
  const panel = sheetRef.value?.panelEl;
  if (!panel || fromHeight <= 0 || typeof panel.animate !== 'function') return;
  const toHeight = panel.offsetHeight;
  if (toHeight <= 0 || Math.abs(toHeight - fromHeight) < 1) return;
  panel.getAnimations?.().forEach((animation) => animation.cancel());
  panel.animate(
    [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
    { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}

function clearLongPress(): void {
  if (longPressTimer !== undefined) clearTimeout(longPressTimer);
  longPressTimer = undefined;
}

function isRowTruncated(row: HTMLElement): boolean {
  return [...row.querySelectorAll<HTMLElement>('.mqs-name, .mqs-provider')].some(
    (el) => el.scrollWidth > el.clientWidth + 1,
  );
}

function openDetail(model: AppModel, fromSearch: boolean): void {
  detailModel.value = model;
  detailFromSearch.value = fromSearch;
  page.value = 'detail';
}

function onRowPointerDown(e: PointerEvent, model: AppModel, fromSearch: boolean): void {
  clearLongPress();
  suppressRowClick = false;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const row = e.currentTarget as HTMLElement;
  if (!isRowTruncated(row)) return;
  pressStartX = e.clientX;
  pressStartY = e.clientY;
  longPressTimer = setTimeout(() => {
    longPressTimer = undefined;
    suppressRowClick = true;
    openDetail(model, fromSearch);
  }, 500);
}

function onRowPointerMove(e: PointerEvent): void {
  if (longPressTimer === undefined) return;
  if (Math.abs(e.clientX - pressStartX) > 8 || Math.abs(e.clientY - pressStartY) > 8) clearLongPress();
}

function goBack(): void {
  if (page.value === 'detail' && detailFromSearch.value) {
    page.value = 'main';
    void nextTick(() => searchInputEl.value?.focus());
    return;
  }
  page.value = 'main';
}

function chooseProvider(providerId: string): void {
  emit('selectProvider', providerId);
  page.value = 'main';
}

function chooseEffort(segment: string): void {
  emit('selectEffort', segment);
  page.value = 'main';
}

function stageModel(model: AppModel, effort: string | undefined, fromSearch: boolean): void {
  pendingRevealModelId = model.id;
  query.value = '';
  detailModel.value = undefined;
  searchInputEl.value?.blur();
  if (page.value !== 'main') {
    page.value = 'main';
  } else {
    pendingRevealModelId = undefined;
    void nextTick(() => revealStagedModel(model.id));
  }
  emit('selectModel', model.id, effort, fromSearch);
}

function onModelRowClick(model: AppModel, fromSearch: boolean): void {
  if (suppressRowClick) {
    suppressRowClick = false;
    return;
  }
  if (fromSearch && supportsThinkingSubmenu(model)) {
    openDetail(model, true);
    return;
  }
  stageModel(model, undefined, fromSearch);
}

function chooseDetailEffort(segment: string): void {
  const model = detailModel.value;
  if (!model) return;
  stageModel(model, commitLevel(model, segment), detailFromSearch.value);
}

function clearSearch(): void {
  query.value = '';
  searchInputEl.value?.focus();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || isComposingKeyEvent(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (page.value !== 'main') goBack();
  else emit('dismiss');
}

watch(
  () => props.modelValue,
  (open) => {
    clearLongPress();
    if (!open) return;
    page.value = 'main';
    detailModel.value = undefined;
    pendingRevealModelId = undefined;
    query.value = '';
    suppressRowClick = false;
  },
);

watch(
  page,
  async (next) => {
    clearLongPress();
    const fromHeight = sheetRef.value?.panelEl?.offsetHeight ?? 0;
    await nextTick();
    const body = scrollEl.value;
    if (next === 'provider' && providerRowEl.value) {
      scrollRowWithinSheet(providerRowEl.value, 'center');
    } else if (next === 'main' && pendingRevealModelId !== undefined) {
      const modelId = pendingRevealModelId;
      pendingRevealModelId = undefined;
      revealStagedModel(modelId);
    } else if (body) {
      body.scrollTop = 0;
    }
    transitionSheetHeight(fromHeight);
    listScrollbar.sync();
  },
  { flush: 'pre' },
);

watch([query, () => props.payload().providerModels, () => props.payload().activeProvider], () => {
  void nextTick(listScrollbar.sync);
});

onUnmounted(clearLongPress);
</script>

<template>
  <BottomSheet
    ref="sheetRef"
    :model-value="props.modelValue"
    :title="sheetTitle"
    :show-back="page !== 'main'"
    :close-on-esc="false"
    :body-scroll="false"
    :max-height-ratio="0.9"
    @update:model-value="emit('update:modelValue', $event)"
    @back="goBack"
  >
    <div class="mqs" @keydown="onKeydown">
      <template v-if="page === 'main'">
        <div class="mqs-fixed">
          <div class="mqs-search-wrap">
            <div class="mqs-search" :class="{ 'is-active': searchFocused || query.length > 0 }">
              <Icon name="search" size="md" class="mqs-search-icon" />
              <input
                ref="searchInputEl"
                v-model="query"
                class="mqs-search-input"
                type="text"
                autocomplete="off"
                spellcheck="false"
                enterkeyhint="search"
                :placeholder="t('status.searchModels')"
                :aria-label="t('status.searchModels')"
                @focus="searchFocused = true"
                @blur="searchFocused = false"
                @compositionstart="handleCompositionStart"
                @compositionend="handleCompositionEnd"
              />
              <button
                v-if="query.length > 0"
                type="button"
                class="mqs-search-clear"
                :aria-label="t('mobile.clearSearch')"
                @click="clearSearch"
              >
                <Icon name="close" size="md" />
              </button>
            </div>
          </div>

          <template v-if="searching">
            <div v-if="searchResults.length > 0" class="mqs-label">{{ t('status.searchResults') }}</div>
          </template>
          <template v-else>
            <div v-if="menu.recentModels.length > 0" class="mqs-list">
              <div class="mqs-label">{{ t('status.recentModels') }}</div>
              <button
                v-for="model in menu.recentModels"
                :key="`recent:${model.id}`"
                :ref="setRowElement(`recent:${model.id}`)"
                type="button"
                class="mqs-row"
                role="menuitemradio"
                :aria-checked="model.id === menu.currentModelId"
                :data-row-key="`recent:${model.id}`"
                @pointerdown="onRowPointerDown($event, model, false)"
                @pointermove="onRowPointerMove"
                @pointerup="clearLongPress"
                @pointercancel="clearLongPress"
                @click="onModelRowClick(model, false)"
              >
                <span class="mqs-name">{{ model.displayName ?? model.model }}</span>
                <span class="mqs-provider">{{ providerDisplayName(model.provider, t) }}</span>
                <Icon v-if="model.id === menu.currentModelId" name="check" size="md" class="mqs-check" />
              </button>
              <div class="mqs-divider" />
            </div>
            <div v-if="menu.providerModels.length > 0 || menu.activeProvider" class="mqs-label">{{ menu.activeProviderLabel }}</div>
          </template>
        </div>

        <div
          ref="scrollEl"
          class="mqs-scroll"
          :style="{ maskImage: listScrollbar.maskImage.value }"
          @scroll="listScrollbar.onScroll"
          @mouseenter="listScrollbar.onListMouseEnter"
          @mouseleave="listScrollbar.onListMouseLeave"
        >
          <div v-if="searching" class="mqs-list">
            <template v-if="searchResults.length > 0">
              <button
                v-for="entry in searchResults"
                :key="`search:${entry.model.id}`"
                type="button"
                class="mqs-row"
                :class="{ 'is-provider-match': entry.matchedProvider }"
                :data-row-key="`search:${entry.model.id}`"
                @pointerdown="onRowPointerDown($event, entry.model, true)"
                @pointermove="onRowPointerMove"
                @pointerup="clearLongPress"
                @pointercancel="clearLongPress"
                @click="onModelRowClick(entry.model, true)"
              >
                <span class="mqs-name">
                  <template v-for="(part, index) in highlightSearchText(entry.modelName, entry.modelRanges)" :key="index"><span v-if="part.matched" class="mqs-match">{{ part.text }}</span><template v-else>{{ part.text }}</template></template>
                </span>
                <span class="mqs-provider">
                  <template v-for="(part, index) in highlightSearchText(entry.providerName, entry.providerRanges)" :key="index"><span v-if="part.matched" class="mqs-match">{{ part.text }}</span><template v-else>{{ part.text }}</template></template>
                </span>
                <Icon v-if="supportsThinkingSubmenu(entry.model)" name="chevron-right" size="md" class="mqs-trailing" />
              </button>
            </template>
            <div v-else class="mqs-empty" role="status">{{ t('status.noMatchingModels') }}</div>
          </div>

          <div v-else class="mqs-list">
            <button
              v-for="model in menu.providerModels"
              :key="`provider:${model.id}`"
              :ref="setRowElement(`provider:${model.id}`)"
              type="button"
              class="mqs-row"
              role="menuitemradio"
              :aria-checked="model.id === menu.currentModelId"
              :data-row-key="`provider:${model.id}`"
              @pointerdown="onRowPointerDown($event, model, false)"
              @pointermove="onRowPointerMove"
              @pointerup="clearLongPress"
              @pointercancel="clearLongPress"
              @click="onModelRowClick(model, false)"
            >
              <span class="mqs-name">{{ model.displayName ?? model.model }}</span>
              <Icon v-if="model.id === menu.currentModelId" name="check" size="md" class="mqs-check" />
            </button>
          </div>
        </div>

        <div v-if="!searching" class="mqs-fixed">
          <div class="mqs-list">
            <div class="mqs-divider" />
            <button
              v-if="menu.providers.length > 0"
              type="button"
              class="mqs-row"
              data-row-key="action:provider"
              @click="page = 'provider'"
            >
              <span class="mqs-action-label">{{ t('status.switchProvider') }}</span>
              <span class="mqs-action-value">{{ menu.activeProviderLabel }}</span>
              <Icon name="chevron-right" size="md" class="mqs-trailing" />
            </button>
            <button
              type="button"
              class="mqs-row"
              :class="{ 'is-disabled': !effortExpandable }"
              :disabled="!effortExpandable"
              :aria-disabled="!effortExpandable"
              data-row-key="action:effort"
              @click="page = 'effort'"
            >
              <span class="mqs-action-label">{{ t('status.statusThinking') }}</span>
              <span class="mqs-action-value">{{ effortValueLabel }}</span>
              <Icon v-if="effortExpandable" name="chevron-right" size="md" class="mqs-trailing" />
            </button>
          </div>
        </div>
      </template>

      <div
        v-else-if="page === 'provider'"
        ref="scrollEl"
        class="mqs-scroll"
        :style="{ maskImage: listScrollbar.maskImage.value }"
        @scroll="listScrollbar.onScroll"
        @mouseenter="listScrollbar.onListMouseEnter"
        @mouseleave="listScrollbar.onListMouseLeave"
      >
        <div class="mqs-list">
          <button
            v-for="provider in menu.providers"
            :key="provider.id"
            :ref="provider.id === menu.activeProvider ? (el) => { providerRowEl = el as HTMLElement | undefined; } : undefined"
            type="button"
            class="mqs-row"
            role="menuitemradio"
            :aria-checked="provider.id === menu.activeProvider"
            :data-provider-id="provider.id"
            @click="chooseProvider(provider.id)"
          >
            <span class="mqs-name">{{ provider.label }}</span>
            <Icon v-if="provider.id === menu.activeProvider" name="check" size="md" class="mqs-check" />
          </button>
        </div>
      </div>

      <template v-else-if="page === 'effort'">
        <p class="mqs-desc mqs-fixed">{{ thinkingDescription }}</p>
        <div
          ref="scrollEl"
          class="mqs-scroll"
          :style="{ maskImage: listScrollbar.maskImage.value }"
          @scroll="listScrollbar.onScroll"
          @mouseenter="listScrollbar.onListMouseEnter"
          @mouseleave="listScrollbar.onListMouseLeave"
        >
          <div class="mqs-list">
            <button
              v-for="segment in currentSegments"
              :key="segment"
              type="button"
              class="mqs-row"
              role="menuitemradio"
              :aria-checked="segment === currentEffortValue"
              :data-effort="segment"
              @click="chooseEffort(segment)"
            >
              <span class="mqs-name">{{ effortLabel(segment) }}</span>
              <Icon v-if="segment === currentEffortValue" name="check" size="md" class="mqs-check" />
            </button>
          </div>
        </div>
      </template>

      <template v-else-if="page === 'detail' && detailModel">
        <div class="mqs-fixed">
          <div class="mqs-detail-subtitle">{{ providerDisplayName(detailModel.provider, t) }}</div>
          <ul v-if="detailCapabilities.length > 0" class="mqs-caps">
            <li v-for="item in detailCapabilities" :key="item.kind" class="mqs-cap">
              <Icon name="check-check" size="md" class="mqs-cap-icon" />
              <span>{{ modelCapabilityText(item, t) }}</span>
            </li>
          </ul>
          <template v-if="supportsThinkingSubmenu(detailModel)">
            <div class="mqs-list">
              <div class="mqs-divider" />
            </div>
            <div class="mqs-label">{{ t('status.statusThinking') }}</div>
          </template>
        </div>
        <div
          v-if="supportsThinkingSubmenu(detailModel)"
          ref="scrollEl"
          class="mqs-scroll"
          :style="{ maskImage: listScrollbar.maskImage.value }"
          @scroll="listScrollbar.onScroll"
          @mouseenter="listScrollbar.onListMouseEnter"
          @mouseleave="listScrollbar.onListMouseLeave"
        >
          <div class="mqs-list">
            <button
              v-for="segment in detailSegments"
              :key="segment"
              type="button"
              class="mqs-row"
              role="menuitemradio"
              :aria-checked="detailModel.id === menu.currentModelId && segment === currentEffortValue"
              :data-detail-effort="segment"
              @click="chooseDetailEffort(segment)"
            >
              <span class="mqs-name">{{ effortLabel(segment) }}</span>
              <Icon
                v-if="detailModel.id === menu.currentModelId && segment === currentEffortValue"
                name="check"
                size="md"
                class="mqs-check"
              />
            </button>
          </div>
        </div>
      </template>

      <div class="mqs-safe-bottom" aria-hidden="true" />
      <ModelMenuScrollThumb :scrollbar="listScrollbar" />
    </div>
  </BottomSheet>
</template>

<style scoped>
.mqs {
  --model-scroll-thumb-right: 3px;
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--color-text);
  font-family: var(--font-ui);
}
.mqs-fixed {
  flex: none;
}
.mqs-scroll {
  --overlay-scrollbar-track-inset: 2px;
  --overlay-scrollbar-thumb-min: 24px;
  flex: 0 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.mqs-scroll::-webkit-scrollbar {
  display: none;
}
.mqs-safe-bottom {
  flex: none;
  height: max(8px, var(--safe-bottom, 0px));
}
.mqs-search-wrap {
  flex: none;
  padding: 0 16px 8px;
}
.mqs-search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  border: var(--p-hairline) solid transparent;
  border-radius: 10px;
  background: var(--color-fill-1);
  box-sizing: border-box;
}
.mqs-search.is-active {
  border-color: var(--color-line);
  background: var(--color-surface-raised);
}
.mqs-search-icon {
  flex: none;
  color: var(--color-text-faint);
}
.mqs-search-input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--text-base);
  line-height: calc(20px + var(--ui-shift));
}
.mqs-search-input::placeholder {
  color: var(--color-text-faint);
}
.mqs-search-clear {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-right: -6px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.mqs-list {
  display: flex;
  flex-direction: column;
  padding: 0 8px;
}
.mqs-label {
  display: flex;
  align-items: center;
  padding: 10px 20px 4px;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: calc(18px + var(--ui-shift));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mqs-list .mqs-label {
  padding: 10px 12px 4px;
}
.mqs-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: calc(44px + var(--ui-shift) * 2);
  min-height: 44px;
  padding: 0 12px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--text-base);
  line-height: calc(20px + var(--ui-shift));
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  box-sizing: border-box;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: pan-y;
}
.mqs-row:active:not(.is-disabled),
.mqs-row:focus-visible {
  background: var(--color-hover);
}
.mqs-row:focus-visible {
  outline: var(--p-focus-ring-w) solid var(--color-accent-soft);
  outline-offset: calc(-1 * var(--p-focus-ring-w));
}
.mqs-row.is-disabled {
  cursor: default;
}
.mqs-row.is-disabled .mqs-action-label {
  color: var(--color-text-faint);
}
.mqs-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  text-overflow: ellipsis;
}
.mqs-row:not(:has(.mqs-provider)) .mqs-name {
  flex: 1 1 auto;
}
.mqs-provider,
.mqs-action-value {
  overflow: hidden;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: calc(18px + var(--ui-shift));
  text-overflow: ellipsis;
}
.mqs-provider {
  flex: 0 100000 auto;
  min-width: 64px;
}
.mqs-row.is-provider-match .mqs-provider {
  flex: 0 0 auto;
  min-width: 0;
  max-width: 96px;
}
.mqs-match {
  color: var(--color-accent);
}
.mqs-action-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mqs-action-value {
  flex: 0 0 auto;
  max-width: 120px;
}
.mqs-trailing,
.mqs-check {
  flex: none;
}
.mqs-trailing {
  color: var(--color-text-muted);
}
.mqs-check {
  color: var(--color-text);
}
.mqs-divider {
  flex: none;
  padding: 4px 12px;
}
.mqs-divider::after {
  content: '';
  display: block;
  width: 100%;
  height: var(--p-hairline);
  background: var(--color-line);
}
.mqs-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 72px;
  padding: 16px;
  color: var(--color-text-faint);
  font-size: var(--text-base);
  text-align: center;
}
.mqs-desc {
  margin: 0;
  padding: 6px 20px 10px;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: calc(18px + var(--ui-shift));
}
.mqs-detail-subtitle {
  padding: 0 20px 4px;
  overflow: hidden;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: calc(18px + var(--ui-shift));
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mqs-caps {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 4px 20px;
  list-style: none;
}
.mqs-cap {
  display: flex;
  align-items: center;
  gap: 8px;
  height: calc(32px + var(--ui-shift));
  min-height: 32px;
  color: var(--color-text-muted);
  font-size: var(--text-base);
  line-height: calc(20px + var(--ui-shift));
}
.mqs-cap-icon {
  flex: none;
  color: var(--color-text-muted);
}
</style>
