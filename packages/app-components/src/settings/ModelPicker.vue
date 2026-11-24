<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { MANAGED_KIMI_CODE_PROVIDER_ID, type AppModel } from '@moonshot-ai/app-core/api';
import { useDialogFocus } from '@moonshot-ai/app-components';
import { formatTokens, providerDisplayName } from '@moonshot-ai/app-core/lib';
import { Dialog, Icon, IconButton, Input, Kbd, Spinner, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import { useIsMobile } from '@moonshot-ai/app-client/composables';
import BottomSheet from '../dialogs/BottomSheet.vue';

const { t } = useI18n();

const props = defineProps<{
  models: AppModel[];
  current: string;
  starredIds?: string[];
  loading?: boolean;
  unavailable?: boolean;
}>();

const emit = defineEmits<{
  select: [modelId: string];
  'toggle-star': [modelId: string];
  close: [];
}>();

const starredSet = computed(() => new Set(props.starredIds ?? []));
function isStarred(modelId: string): boolean {
  return starredSet.value.has(modelId);
}

const query = ref('');
const searchRef = ref<HTMLInputElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const activeTab = ref('all');

const CAPABILITY_LABEL_KEYS: Record<string, string> = {
  image_in: 'model.capabilityImageInput',
  video_in: 'model.capabilityVideoInput',
  tool_use: 'model.capabilityToolUse',
  thinking: 'model.capabilityThinking',
  always_thinking: 'model.capabilityAlwaysThinking',
};

function capabilityLabel(capability: string): string {
  const key = CAPABILITY_LABEL_KEYS[capability];
  return key ? t(key) : capability.replaceAll('_', ' ');
}

function metaText(m: AppModel): string {
  const parts = [providerDisplayName(m.provider, t), t('model.contextSuffix', { size: formatTokens(m.maxContextSize) })];
  for (const cap of m.capabilities ?? []) parts.push(capabilityLabel(cap));
  return parts.join(' · ');
}

const isCoarsePointer =
  typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
useDialogFocus(dialogRef, isCoarsePointer ? undefined : searchRef);

const isMobile = useIsMobile();
const shell = computed(() => (isMobile.value ? BottomSheet : Dialog));
const shellProps = computed(() =>
  isMobile.value
    ? { modelValue: true, title: t('model.title'), closeOnEsc: false }
    : {
        open: true,
        closeOnEsc: false,
        title: t('model.title'),
        size: 'lg' as const,
        height: 'fixed' as const,
        padded: false,
        focusOnOpen: !isCoarsePointer,
      },
);

const providerTabs = computed(() => {
  const seen = new Set<string>();
  const providerIds: string[] = [];
  for (const model of props.models) {
    if (seen.has(model.provider)) continue;
    seen.add(model.provider);
    providerIds.push(model.provider);
  }
  const orderedProviderIds = seen.has(MANAGED_KIMI_CODE_PROVIDER_ID)
    ? [MANAGED_KIMI_CODE_PROVIDER_ID, ...providerIds.filter((id) => id !== MANAGED_KIMI_CODE_PROVIDER_ID)]
    : providerIds;
  return [
    { id: 'all', label: t('model.allTab') },
    ...orderedProviderIds.map((id) => ({ id, label: providerDisplayName(id, t) })),
  ];
});

const filtered = computed<AppModel[]>(() => {
  const q = query.value.toLowerCase().trim();
  const list = props.models.filter((m) => {
    if (activeTab.value !== 'all' && m.provider !== activeTab.value) return false;
    const matchName = (m.displayName ?? m.model).toLowerCase().includes(q);
    const matchProvider =
      m.provider.toLowerCase().includes(q) ||
      providerDisplayName(m.provider, t).toLowerCase().includes(q);
    const matchId = m.id.toLowerCase().includes(q);
    return !q || matchName || matchProvider || matchId;
  });
  if (activeTab.value !== 'all') return list;
  return list.sort((a, b) => {
    const aStarred = isStarred(a.id) ? 1 : 0;
    const bStarred = isStarred(b.id) ? 1 : 0;
    return bStarred - aStarred;
  });
});

const flat = computed<AppModel[]>(() => filtered.value);
const selectedIdx = ref(0);

watch([query, activeTab], () => { selectedIdx.value = 0; });
watch(providerTabs, (tabs) => {
  if (!tabs.some((tab) => tab.id === activeTab.value)) activeTab.value = 'all';
});
watch(flat, (items) => {
  selectedIdx.value = Math.min(selectedIdx.value, Math.max(items.length - 1, 0));
});

watch(selectedIdx, async () => {
  await nextTick();
  listRef.value
    ?.querySelector('.model-row.is-selected')
    ?.scrollIntoView({ block: 'nearest' });
});

const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

function handleKeydown(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  if (e.key === 'Escape') {
    emit('close');
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIdx.value = Math.min(selectedIdx.value + 1, flat.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIdx.value = Math.max(selectedIdx.value - 1, 0);
  } else if (e.key === 'Enter') {
    const m = flat.value[selectedIdx.value];
    if (m) {
      emit('select', m.id);
    }
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
});
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});

function choose(modelId: string): void {
  emit('select', modelId);
}

function clearQuery(): void {
  query.value = '';
  searchRef.value?.focus();
}

function flatIdx(m: AppModel): number {
  return flat.value.indexOf(m);
}

function selectTab(tabId: string): void {
  activeTab.value = tabId;
}
</script>

<template>
  <component :is="shell" v-bind="shellProps" @close="emit('close')">
    <div ref="dialogRef" class="mp" :class="{ 'mp--sheet': isMobile }">
      <div class="search-wrap">
        <Input
          ref="searchRef"
          v-model="query"
          :placeholder="t('model.searchPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          :autofocus="!isCoarsePointer"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
        />
        <Tooltip :text="t('model.clearSearch')">
          <button
            type="button"
            class="search-clear"
            :class="{ 'is-on': query.length > 0 }"
            tabindex="-1"
            :aria-label="t('model.clearSearch')"
            @click="clearQuery"
          >
            <Icon name="close" size="sm" />
          </button>
        </Tooltip>
      </div>

      <div v-if="providerTabs.length > 1" class="chip-strip" :aria-label="t('model.providerTabs')">
        <button
          v-for="tab in providerTabs"
          :key="tab.id"
          type="button"
          class="chip"
          :class="{ 'is-active': tab.id === activeTab }"
          :aria-pressed="tab.id === activeTab"
          @click="selectTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>

      <div v-if="loading" class="state-row">
        <Spinner size="sm" />
        <span>{{ t('model.loading') }}</span>
      </div>

      <div v-else-if="unavailable" class="state-row unavail">
        <Icon name="alert-triangle" size="lg" />
        <span>{{ t('model.unavailable') }}</span>
      </div>

      <div v-else ref="listRef" class="model-list" role="listbox" :aria-label="t('model.title')">
        <div
          v-for="m in flat"
          :key="m.id"
          class="model-row"
          :class="{
            'is-current': m.id === current,
            'is-selected': flatIdx(m) === selectedIdx,
          }"
          role="option"
          :aria-selected="m.id === current"
          @click="choose(m.id)"
          @mouseenter="selectedIdx = flatIdx(m)"
        >
          <span class="model-main">
            <span class="model-name">{{ m.displayName ?? m.model }}</span>
            <span class="model-meta">{{ metaText(m) }}</span>
          </span>
          <span class="model-side">
            <Icon v-if="m.id === current" class="model-check" name="check" size="sm" />
            <IconButton
              class="model-star"
              :class="{ 'is-starred': isStarred(m.id) }"
              size="sm"
              :label="isStarred(m.id) ? t('model.unstarTitle') : t('model.starTitle')"
              :tooltip="isStarred(m.id) ? t('model.unstarTitle') : t('model.starTitle')"
              @click.stop="emit('toggle-star', m.id)"
            >
              <Icon v-if="isStarred(m.id)" name="star" size="md" />
              <Icon v-else name="star-outline" size="md" />
            </IconButton>
          </span>
        </div>
        <div v-if="flat.length === 0" class="empty">
          {{ props.models.length === 0 ? t('model.emptyNoModels') : t('model.emptyNoMatch') }}
        </div>
      </div>

      <div class="footer-hint" aria-hidden="true">
        <Kbd :keys="['arrowup', 'arrowdown']" />
        <span>{{ t('model.hintNavigate') }}</span>
        <span class="hint-dot">·</span>
        <Kbd :keys="['enter']" />
        <span>{{ t('model.hintSelect') }}</span>
        <span class="hint-dot">·</span>
        <Kbd :keys="['escape']" />
        <span>{{ t('model.hintClose') }}</span>
      </div>
    </div>
  </component>
</template>

<style scoped>
.mp { display: flex; flex-direction: column; gap: var(--space-2); height: 100%; min-height: 0; padding-top: 4px; }

.mp--sheet { height: auto; padding-top: 0; }
.mp--sheet .search-wrap,
.mp--sheet .chip-strip { margin: 0 16px; }

.search-wrap { position: relative; margin: 0 22px; padding-bottom: var(--space-1); }
.search-wrap :deep(.ui-input) { padding-right: 30px; }

.search-clear {
  position: absolute;
  top: 0;
  bottom: var(--space-1);
  right: var(--space-2);
  margin-block: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-hover);
  color: var(--color-text-faint);
  cursor: pointer;
  visibility: hidden;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out), visibility var(--duration-fast),
    background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.search-clear.is-on { visibility: visible; opacity: 1; }
.search-clear:hover { background: var(--color-selected); color: var(--color-text-muted); }
.search-clear:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

.chip-strip {
  display: flex;
  gap: var(--space-1);
  margin: 0 22px;
  overflow-x: auto;
  scrollbar-width: none;
}
.chip-strip::-webkit-scrollbar { display: none; }

.chip {
  flex: none;
  height: 28px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.chip:hover { background: var(--color-hover); color: var(--color-text); }
.chip.is-active {
  background: var(--color-selected);
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.chip:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

.model-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-1) var(--space-2);
}

.model-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  cursor: pointer;
  color: var(--color-text);
  min-width: 0;
  transition: background var(--duration-fast) var(--ease-out);
}
.model-row:hover, .model-row.is-selected {
  background: var(--color-hover);
}
.model-row.is-current {
  background: var(--color-selected);
}

.model-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.model-name {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: 20px;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-row.is-current .model-name { font-weight: var(--weight-medium); }
.model-meta {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: 18px;
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-side {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}
.model-check { color: var(--color-text); }

.model-star {
  color: var(--color-text-faint);
  visibility: hidden;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out), visibility var(--duration-fast);
}
.model-row:hover .model-star,
.model-row.is-selected .model-star,
.model-star.is-starred,
.model-star:focus-visible {
  visibility: visible;
  opacity: 1;
}
.model-star.is-starred { color: var(--star); }
@media (hover: none) {
  .model-star { visibility: visible; opacity: 1; }
}

.state-row {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}
.state-row.unavail { color: var(--color-warning); }

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}

.footer-hint {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-4);
  border-top: var(--p-hairline) solid var(--color-line);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.hint-dot { margin: 0 var(--space-1); }

@media (hover: none) {
  .footer-hint { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .chip, .model-row, .model-star, .search-clear { transition: none; }
}
</style>
