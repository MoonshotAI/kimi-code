<!-- apps/kimi-web/src/components/QuotaCard.vue -->
<!-- Persistent plan-quota card shown at the top of the sidebar. Fetches the
     managed 5h/weekly windows on mount and renders each with a severity-tinted
     progress bar, so the current budget pressure is visible without running a
     command. Hidden entirely when the provider has no managed quota (signed
     out or non-managed provider). -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../api';
import type { AppManagedUsageResult, AppManagedUsageRow } from '../api/types';

const { t } = useI18n();

const result = ref<AppManagedUsageResult | null>(null);
const loading = ref(false);
const failed = ref(false);

type Severity = 'ok' | 'warn' | 'danger';

function severityOf(row: AppManagedUsageRow): Severity {
  if (row.limit <= 0) return 'ok';
  const ratio = row.used / row.limit;
  if (ratio >= 0.85) return 'danger';
  if (ratio >= 0.5) return 'warn';
  return 'ok';
}

function pctOf(row: AppManagedUsageRow): number {
  if (row.limit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil((row.used / row.limit) * 100)));
}

function shortLabel(label: string): string {
  return label.replace(/\s+limit$/i, '');
}

// Weekly summary first (1w), then each window limit (incl. 5h) in arrival order.
const rows = computed<AppManagedUsageRow[]>(() => {
  const r = result.value;
  if (r === null || r.kind !== 'ok') return [];
  const out: AppManagedUsageRow[] = [];
  if (r.summary !== null) out.push(r.summary);
  out.push(...r.limits);
  return out;
});

const visible = computed(() => rows.value.length > 0 || failed.value);
const errorMessage = computed(() =>
  result.value?.kind === 'error' ? (result.value.message ?? t('status.quotaUnavailable')) : '',
);

async function refresh(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  try {
    const data = await getKimiWebApi().getManagedUsage();
    result.value = data;
    failed.value = false;
  } catch {
    failed.value = true;
    result.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <div v-if="visible" class="quota-card">
    <div class="quota-head">
      <span class="quota-title">{{ t('status.quotaTitle') }}</span>
      <button
        class="quota-refresh"
        type="button"
        :disabled="loading"
        @click="refresh"
      >
        {{ loading ? t('status.quotaRefreshing') : t('status.quotaRefresh') }}
      </button>
    </div>

    <div v-if="failed || result?.kind === 'error'" class="quota-error">
      <span class="quota-error-text">{{ errorMessage || t('status.quotaUnavailable') }}</span>
      <button class="quota-retry" type="button" @click="refresh">{{ t('status.quotaRetry') }}</button>
    </div>

    <div v-else class="quota-rows">
      <div v-for="row in rows" :key="row.label" class="quota-row">
        <div class="quota-row-top">
          <span class="quota-label">{{ shortLabel(row.label) }}</span>
          <span class="quota-pct" :data-sev="severityOf(row)">
            {{ t('status.quotaUsed', { pct: pctOf(row) }) }}
          </span>
        </div>
        <div class="quota-bar">
          <i
            :data-sev="severityOf(row)"
            :style="{ width: pctOf(row) + '%' }"
          ></i>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quota-card {
  margin: 0 var(--space-3) var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-family: var(--font-ui);
}

.quota-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.quota-title {
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.quota-refresh,
.quota-retry {
  border: none;
  background: transparent;
  color: var(--color-accent);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
}
.quota-refresh:hover:not(:disabled),
.quota-retry:hover {
  background: var(--color-surface-sunken);
}
.quota-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}

.quota-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.quota-row-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
.quota-label {
  font-size: var(--text-sm);
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.quota-pct {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.quota-pct[data-sev='warn'] { color: var(--color-warning); }
.quota-pct[data-sev='danger'] { color: var(--color-danger); }

.quota-bar {
  width: 100%;
  height: 5px;
  margin-top: 3px;
  border-radius: var(--radius-full);
  background: var(--color-line);
  overflow: hidden;
}
.quota-bar i {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  transition: width var(--duration-base) var(--ease-out);
}
.quota-bar i[data-sev='warn'] { background: var(--color-warning); }
.quota-bar i[data-sev='danger'] { background: var(--color-danger); }

.quota-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.quota-error-text {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
