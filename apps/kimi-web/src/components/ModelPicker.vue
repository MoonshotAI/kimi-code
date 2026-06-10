<!-- apps/kimi-web/src/components/ModelPicker.vue -->
<!-- Modal overlay for switching the active session's model. -->
<!-- Light only, monospace-forward, Kimi blue #1565C0, no emoji. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppModel } from '../api/types';

const { t } = useI18n();

const props = defineProps<{
  models: AppModel[];
  current: string;
  loading?: boolean;
  /** If true, models could not be fetched (daemon 404 / unsupported) */
  unavailable?: boolean;
}>();

const emit = defineEmits<{
  select: [modelId: string];
  close: [];
}>();

// -------------------------------------------------------------------------
// Search + filtered list
// -------------------------------------------------------------------------

const query = ref('');
const searchRef = ref<HTMLInputElement | null>(null);

const grouped = computed<Map<string, AppModel[]>>(() => {
  const q = query.value.toLowerCase().trim();
  const result = new Map<string, AppModel[]>();
  for (const m of props.models) {
    const matchName = (m.displayName ?? m.model).toLowerCase().includes(q);
    const matchProvider = m.provider.toLowerCase().includes(q);
    const matchId = m.id.toLowerCase().includes(q);
    if (!q || matchName || matchProvider || matchId) {
      const bucket = result.get(m.provider) ?? [];
      bucket.push(m);
      result.set(m.provider, bucket);
    }
  }
  return result;
});

const flat = computed<AppModel[]>(() => {
  const out: AppModel[] = [];
  for (const items of grouped.value.values()) {
    out.push(...items);
  }
  return out;
});

const selectedIdx = ref(0);

// Reset selection when filter changes
import { watch } from 'vue';
watch(query, () => { selectedIdx.value = 0; });

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
  nextTick(() => searchRef.value?.focus());
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
</script>

<template>
  <!-- Backdrop -->
  <div class="backdrop" @click.self="emit('close')">
    <!-- Dialog -->
    <div class="dialog" role="dialog" :aria-label="t('model.dialogLabel')">
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

      <!-- Model list grouped by provider -->
      <div v-else class="model-list">
        <template v-for="[provId, items] in grouped" :key="provId">
          <div class="group-label">{{ provId }}</div>
          <div
            v-for="m in items"
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
            <span class="check">{{ m.id === current ? '✓' : '' }}</span>
            <span class="model-name">{{ m.displayName ?? m.model }}</span>
            <span class="model-ctx">{{ t('model.contextSuffix', { size: Math.round(m.maxContextSize / 1000) }) }}</span>
            <span v-if="m.capabilities && m.capabilities.length > 0" class="caps">
              {{ m.capabilities.join(', ') }}
            </span>
          </div>
        </template>
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
  border-top: 2px solid var(--blue);
  border-radius: 4px;
  width: 540px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  font-family: var(--mono);
  box-shadow: 0 8px 32px rgba(0,0,0,0.14);
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
  font-size: 12.5px;
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
  font-size: 14px;
  padding: 2px 4px;
  line-height: 1;
}
.close-btn:hover { color: var(--ink); }

/* Search */
.search-wrap {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line2);
}
.search-input {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--mono);
  font-size: 12.5px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--panel);
  color: var(--ink);
  outline: none;
}


/* Model list */
.model-list {
  overflow-y: auto;
  flex: 1;
  padding: 4px 0;
  min-height: 80px;
}

.group-label {
  font-size: 10px;
  color: var(--muted);
  padding: 8px 14px 3px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-top: 1px solid var(--line2);
  user-select: none;
}
.group-label:first-child { border-top: none; }

.model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text);
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
  font-size: 11px;
  color: var(--blue);
  flex: none;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.model-name {
  flex: 1;
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-ctx {
  color: var(--muted);
  font-size: 11px;
  flex: none;
}
.caps {
  color: var(--blue);
  font-size: 10px;
  border: 1px solid var(--bd);
  border-radius: 3px;
  padding: 1px 5px;
  flex: none;
}

.loading-state,
.unavail-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px 14px;
  color: var(--dim);
  font-size: 14px;
}
.unavail-state { color: var(--warn); }

.empty {
  padding: 20px 14px;
  color: var(--muted);
  font-size: 14px;
}

/* Footer */
.footer-hint {
  padding: 6px 14px;
  font-size: 10.5px;
  color: var(--faint);
  border-top: 1px solid var(--line2);
  background: var(--panel);
  border-radius: 0 0 4px 4px;
}
</style>
