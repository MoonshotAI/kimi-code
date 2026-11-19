<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BoosterWallet, ManagedQuotaResult } from '../../api/types';
import {
  formatQuotaLabel,
  formatResetAt,
  moneyParts,
  monthlyBreakdown,
  quotaUsageRows,
  usagePercent,
  usageSeverity,
} from '@moonshot-ai/app-core/lib';
import { track } from '../../lib/track';
import { PlanUpgradeCard } from '@moonshot-ai/app-components';
import { Button, Spinner, Tooltip } from '@moonshot-ai/app-ui';

const props = defineProps<{
  onFetchUsage: () => Promise<ManagedQuotaResult>;
  active: boolean;
}>();

const { t } = useI18n();

const loading = ref(true);
const result = ref<ManagedQuotaResult | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    result.value = await props.onFetchUsage();
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const quota = computed(() => (result.value?.kind === 'ok' ? result.value.quota : null));
const wallet = computed<BoosterWallet | null>(() => quota.value?.extraUsage ?? null);
const usageRows = computed(() => (quota.value === null ? [] : quotaUsageRows(quota.value)));
const breakdown = computed(() => (quota.value === null ? null : monthlyBreakdown(quota.value)));
const hasUsageRows = computed(() => usageRows.value.length > 0);
const errorMessage = computed(() =>
  result.value?.kind === 'error' ? result.value.message : t('settings.planUsage.loadFailed'),
);

const isFreeAccountError = computed(
  () =>
    result.value?.kind === 'error' &&
    (result.value.status === 402 || result.value.status === 403),
);

const hasMonthlyLimit = computed(
  () => wallet.value !== null && wallet.value.monthlyChargeLimitEnabled && wallet.value.monthlyChargeLimitCents > 0,
);

const usageBucket = computed<'ok' | 'warn' | 'danger' | null>(() => {
  if (quota.value === null) return null;
  const buckets = usageRows.value.map((row) => usageSeverity(row.entry.usedRatio));
  const w = wallet.value;
  if (w !== null && hasMonthlyLimit.value) {
    buckets.push(usageSeverity(w.monthlyUsedCents / w.monthlyChargeLimitCents));
  }
  if (buckets.length === 0) return null;
  if (buckets.includes('danger')) return 'danger';
  if (buckets.includes('warn')) return 'warn';
  return 'ok';
});

let viewTracked = false;
watch(
  [() => props.active, usageBucket],
  ([active, bucket]) => {
    if (!active || bucket === null || viewTracked) return;
    viewTracked = true;
    track('plan_usage_card_viewed', { usage_bucket: bucket });
  },
  { immediate: true },
);

function money(cents: number, currency: string): string {
  const parts = moneyParts(cents, currency);
  return `${parts.symbol}${parts.number}`;
}

function resetHint(resetAt: string | undefined): string {
  return resetAt === undefined ? '' : formatResetAt(resetAt, t);
}
</script>

<template>
  <PlanUpgradeCard v-if="isFreeAccountError" />
  <template v-else>
  <section class="sec">
    <h3 class="sec-title">{{ t('settings.planUsage.title') }}</h3>
    <div class="pu-group">
      <div v-if="loading" class="pu-row pu-state">
        <Spinner size="sm" />
      </div>

      <div v-else-if="quota === null" class="pu-row pu-state">
        <span class="pu-error-text">{{ errorMessage }}</span>
        <Button variant="ghost" size="sm" @click="load">{{ t('settings.planUsage.retry') }}</Button>
      </div>

      <div v-else-if="!hasUsageRows" class="pu-row pu-state pu-empty">{{ t('settings.planUsage.empty') }}</div>

      <div v-for="row in usageRows" v-else :key="row.key" class="pu-row">
        <span class="pu-main">
          <span class="pu-label">{{ formatQuotaLabel(row.key, t) }}</span>
          <span v-if="resetHint(row.entry.resetAt)" class="pu-hint">{{ resetHint(row.entry.resetAt) }}</span>
          <span v-if="row.key === 'monthTotal' && breakdown !== null" class="pu-legend">
            <span class="pu-legend-item"><i class="pu-swatch pu-swatch-text" />Kimi</span>
            <span class="pu-legend-item"><i class="pu-swatch pu-swatch-blue" />Code</span>
          </span>
        </span>
        <span class="pu-value">
          {{ t('settings.planUsage.usedPct', { pct: usagePercent(row.entry.usedRatio) }) }}
        </span>
        <span
          v-if="row.key === 'monthTotal' && breakdown !== null"
          class="pu-meter pu-meter-stacked"
          role="progressbar"
          :aria-valuenow="usagePercent(row.entry.usedRatio)"
          aria-valuemax="100"
        >
          <Tooltip :text="t('settings.planUsage.segmentUsage', { name: 'Kimi', pct: usagePercent(breakdown.kimiRatio) })">
            <i class="seg-kimi" :class="{ 'seg-tip': breakdown.codeRatio <= 0 }" :style="{ width: `${usagePercent(breakdown.kimiRatio)}%` }" />
          </Tooltip>
          <Tooltip :text="t('settings.planUsage.segmentUsage', { name: 'Code', pct: usagePercent(breakdown.codeRatio) })">
            <i class="seg-code" :style="{ width: `${usagePercent(breakdown.codeRatio)}%` }" />
          </Tooltip>
        </span>
        <span v-else class="pu-meter" role="progressbar" :aria-valuenow="usagePercent(row.entry.usedRatio)" aria-valuemax="100">
          <i :style="{ width: `${usagePercent(row.entry.usedRatio)}%` }" />
        </span>
      </div>
    </div>
  </section>

  <section v-if="wallet !== null" class="sec">
    <h3 class="sec-title">{{ t('settings.planUsage.boosterTitle') }}</h3>
    <div class="pu-group">
      <div class="pu-row">
        <span class="pu-main">
          <span class="pu-label">{{ t('settings.planUsage.monthlyUsed') }}</span>
        </span>
        <span class="pu-value">
          {{ money(wallet.monthlyUsedCents, wallet.currency) }}<template v-if="hasMonthlyLimit"><span class="pu-value-sub"> / {{ money(wallet.monthlyChargeLimitCents, wallet.currency) }}</span></template>
        </span>
        <span v-if="hasMonthlyLimit" class="pu-meter">
          <i
            :style="{ width: `${usagePercent(wallet.monthlyUsedCents / wallet.monthlyChargeLimitCents)}%` }"
          />
        </span>
      </div>
      <div class="pu-row">
        <span class="pu-main">
          <span class="pu-label">{{ t('settings.planUsage.boosterLimit') }}</span>
        </span>
        <span class="pu-value">
          <template v-if="hasMonthlyLimit">{{ money(wallet.monthlyChargeLimitCents, wallet.currency) }}</template>
          <template v-else>{{ t('settings.planUsage.unlimited') }}</template>
        </span>
      </div>
      <div class="pu-row">
        <span class="pu-main">
          <span class="pu-label">{{ t('settings.planUsage.boosterBalance') }}</span>
        </span>
        <span class="pu-value">
          {{ money(wallet.balanceCents, wallet.currency) }}
        </span>
      </div>
    </div>
  </section>
  </template>
</template>

<style scoped>
.sec {
  margin-bottom: var(--space-5);
}
.sec-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  margin: 0 0 var(--space-3);
}
.pu-group {
  overflow: hidden;
  border-radius: var(--radius-xl);
  background: var(--color-surface);
}
.pu-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 52px;
  padding: var(--space-3) var(--space-4);
  border-top: var(--p-hairline) solid var(--color-line);
}
.pu-row:first-child {
  border-top: none;
}
.pu-state {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.pu-error-text {
  flex: 1;
  min-width: 0;
}
.pu-empty {
  color: var(--color-text-faint);
}
.pu-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.pu-label {
  font-size: var(--text-sm);
  color: var(--color-text);
}
.pu-hint {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.pu-legend {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.pu-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.pu-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.pu-swatch-blue {
  background: var(--blue);
}
.pu-swatch-text {
  background: var(--color-text);
}
.pu-meter-stacked {
  display: flex;
}
.pu-meter.pu-meter-stacked i {
  border-radius: 0;
}
.pu-meter.pu-meter-stacked i.seg-kimi {
  background: var(--color-text);
}
.pu-meter.pu-meter-stacked i.seg-kimi.seg-tip {
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
}
.pu-meter.pu-meter-stacked i.seg-code {
  background: var(--blue);
  border-radius: 0 var(--radius-full) var(--radius-full) 0;
}
.pu-value {
  flex: none;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.pu-value-sub {
  font-weight: var(--weight-regular);
  color: var(--color-text-faint);
}
.pu-meter {
  flex: none;
  width: 120px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--color-line);
  overflow: hidden;
}
.pu-meter i {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  transition: width var(--duration-base) var(--ease-out);
}
</style>
