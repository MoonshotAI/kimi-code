<!-- apps/kimi-web/src/components/ModelPicker.vue -->
<!-- Modal overlay for switching the active session's model. -->
<!-- Light only, monospace-forward, Kimi blue #1565C0, no emoji. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppModel } from '../api/types';
import { useDialogFocus } from '../composables/useDialogFocus';

const { t } = useI18n();

const props = defineProps<{
  models: AppModel[];
  current: string;
  starredIds?: string[];
  loading?: boolean;
  /** If true, models could not be fetched (daemon 404 / unsupported) */
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

// -------------------------------------------------------------------------
// Search + filtered list
// -------------------------------------------------------------------------

const query = ref('');
const searchRef = ref<HTMLInputElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
const activeTab = ref('all');

// Focus the search box on open; restore focus to the opener on close.
useDialogFocus(dialogRef, searchRef);

const providerTabs = computed(() => {
  const seen = new Set<string>();
  const tabs: { id: string; label: string }[] = [{ id: 'all', label: t('model.allTab') }];
  for (const model of props.models) {
    if (seen.has(model.provider)) continue;
    seen.add(model.provider);
    tabs.push({ id: model.provider, label: model.provider });
  }
  return tabs;
});

const filtered = computed<AppModel[]>(() => {
  const q = query.value.toLowerCase().trim();
  const list = props.models.filter((m) => {
    if (activeTab.value !== 'all' && m.provider !== activeTab.value) return false;
    const matchName = (m.displayName ?? m.model).toLowerCase().includes(q);
    const matchProvider = m.provider.toLowerCase().includes(q);
    const matchId = m.id.toLowerCase().includes(q);
    return !q || matchName || matchProvider || matchId;
  });
  if (activeTab.value !== 'all') return list;
  // In the "All" tab, starred models are pinned to the top while preserving
  // the original order within each group.
  return list.sort((a, b) => {
    const aStarred = isStarred(a.id) ? 1 : 0;
    const bStarred = isStarred(b.id) ? 1 : 0;
    return bStarred - aStarred;
  });
});

const flat = computed<AppModel[]>(() => filtered.value);
const selectedIdx = ref(0);

// Reset selection when filter changes
watch([query, activeTab], () => { selectedIdx.value = 0; });
watch(providerTabs, (tabs) => {
  if (!tabs.some((tab) => tab.id === activeTab.value)) activeTab.value = 'all';
});
watch(flat, (items) => {
  selectedIdx.value = Math.min(selectedIdx.value, Math.max(items.length - 1, 0));
});

// -------------------------------------------------------------------------
// Keyboard navigation
// -------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
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

function flatIdx(m: AppModel): number {
  return flat.value.indexOf(m);
}

function selectTab(tabId: string): void {
  activeTab.value = tabId;
}
</script>

<template>
  <!-- Backdrop -->
  <div class="backdrop" @click.self="emit('close')">
    <!-- Dialog -->
    <div ref="dialogRef" class="dialog" role="dialog" aria-modal="true" tabindex="-1" :aria-label="t('model.dialogLabel')">
      <!-- Header -->
      <div class="dh">
        <span class="dtitle">{{ t('model.title') }}</span>
        <button class="close-btn" :title="t('model.close')" @click="emit('close')">✕</button>
      </div>

      <!-- Search -->
      <div class="search-wrap">
        <input
          ref="searchRef"
          v-model="query"
          class="search-input"
          type="text"
          :placeholder="t('model.searchPlaceholder')"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <div v-if="providerTabs.length > 1" class="tab-strip" role="tablist" :aria-label="t('model.providerTabs')">
        <button
          v-for="tab in providerTabs"
          :key="tab.id"
          type="button"
          class="tab-btn"
          :class="{ on: tab.id === activeTab }"
          role="tab"
          :aria-selected="tab.id === activeTab"
          @click="selectTab(tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Loading state -->
      <div v-if="loading" class="loading-state">
        <svg class="spin-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--blue)" stroke-width="1.5">
          <circle cx="8" cy="8" r="6" stroke-dasharray="24 12" stroke-linecap="round">
            <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/>
          </circle>
        </svg>
        <span>{{ t('model.loading') }}</span>
      </div>

      <!-- Unavailable state (daemon 404 / endpoint not supported) -->
      <div v-else-if="unavailable" class="unavail-state">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--warn)" stroke-width="1.5">
          <path d="M10 2 L19 18 H1 Z"/>
          <line x1="10" y1="9" x2="10" y2="13"/>
          <circle cx="10" cy="16" r="0.8" fill="var(--warn)"/>
        </svg>
        <span>{{ t('model.unavailable') }}</span>
      </div>

      <!-- Model list -->
      <div v-else class="model-list">
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
          <span class="check">
            <svg
              v-if="m.id === current"
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 8.5l3.5 3.5L13 4.5"/>
            </svg>
          </span>
          <span class="model-main">
            <span class="model-name">{{ m.displayName ?? m.model }}</span>
            <span class="model-id">{{ m.id }}</span>
          </span>
          <span class="model-provider">{{ m.provider }}</span>
          <span class="model-ctx">{{ t('model.contextSuffix', { size: Math.round(m.maxContextSize / 1000) }) }}</span>
          <span v-if="m.capabilities && m.capabilities.length > 0" class="caps">
            {{ m.capabilities.join(', ') }}
          </span>
          <button
            type="button"
            class="star-btn"
            :class="{ starred: isStarred(m.id) }"
            :title="isStarred(m.id) ? t('model.unstarTitle') : t('model.starTitle')"
            @click.stop="emit('toggle-star', m.id)"
            @mouseenter.stop
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                :fill="isStarred(m.id) ? 'currentColor' : 'none'"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
                d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
              />
            </svg>
          </button>
        </div>
        <div v-if="flat.length === 0 && !loading && !unavailable" class="empty">
          {{ props.models.length === 0 ? t('model.emptyNoModels') : t('model.emptyNoMatch') }}
        </div>
      </div>

      <!-- Footer hint -->
      <div class="footer-hint">{{ t('model.footerHint') }}</div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 23, 28, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.dialog {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  width: 760px;
  max-width: calc(100vw - 32px);
  height: 680px;
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  font-family: var(--mono);
  box-shadow: 0 8px 32px rgba(0,0,0,0.14);
  overflow: hidden;
}

/* Header */
.dh {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  gap: 8px;
}
.dtitle {
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-weight: 700;
  color: var(--ink);
  flex: 1;
  letter-spacing: 0.02em;
}
.close-btn {
  background: none;
  border: none;
  color: var(--faint);
  cursor: pointer;
  font-size: var(--ui-font-size);
  padding: 2px 4px;
  line-height: 1;
}
.close-btn:hover { color: var(--ink); }

/* Search */
.search-wrap {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line2);
  flex: none;
}
.search-input {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 1.5px);
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--panel);
  color: var(--ink);
  outline: none;
}

.tab-strip {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line2);
  background: var(--panel);
  overflow-x: auto;
}
.tab-btn {
  flex: none;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 2px);
  padding: 4px 9px;
  cursor: pointer;
  white-space: nowrap;
}
.tab-btn:hover {
  color: var(--ink);
  background: var(--panel2);
}
.tab-btn.on {
  color: var(--bg);
  background: var(--blue);
  border-color: var(--blue);
  font-weight: 700;
}

/* Model list */
.model-list {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  padding: 6px 0;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  cursor: pointer;
  font-size: calc(var(--ui-font-size) - 1.5px);
  color: var(--text);
  min-width: 0;
}
.model-row:hover, .model-row.is-selected {
  background: var(--soft);
}
.model-row.is-current {
  color: var(--ink);
}

.check {
  width: 14px;
  height: 14px;
  color: var(--blue);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
}
.model-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.model-name {
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-id {
  color: var(--faint);
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-provider {
  color: var(--muted);
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  flex: none;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-ctx {
  color: var(--muted);
  font-size: calc(var(--ui-font-size) - 3px);
  flex: none;
}
.caps {
  color: var(--blue);
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  border: 1px solid var(--bd);
  border-radius: 3px;
  padding: 1px 5px;
  flex: none;
}
.star-btn {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  margin: -4px -6px -4px 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  line-height: 1;
}
.star-btn:hover {
  background: var(--panel2);
  color: var(--star);
}
.star-btn.starred {
  color: var(--star);
}
.star-btn.starred:hover {
  color: var(--faint);
}

.loading-state,
.unavail-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px 14px;
  color: var(--dim);
  font-size: var(--ui-font-size);
  flex: 1;
  justify-content: center;
}
.unavail-state { color: var(--warn); }

.empty {
  padding: 20px 14px;
  color: var(--muted);
  font-size: var(--ui-font-size);
}

/* Footer */
.footer-hint {
  padding: 6px 14px;
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  color: var(--faint);
  border-top: 1px solid var(--line2);
  background: var(--panel);
  flex: none;
}

@media (max-width: 640px) {
  .backdrop {
    align-items: stretch;
    padding: 12px;
  }
  .dialog {
    width: 100%;
    max-width: none;
    height: 640px;
    max-height: calc(100dvh - 24px);
  }
  .model-provider,
  .caps {
    display: none;
  }
}
</style>
