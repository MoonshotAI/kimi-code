<!-- Settings → Account: managed-account plan usage + booster wallet, two
     separate sections (like the TUI `/usage` panel's "Plan usage" and "Extra
     Usage"). Fetches on mount through the injected callback; renders inline
     loading / error(with retry) / empty states so a fetch failure or an older
     daemon never surfaces as a toast. Meter colors follow the TUI severity
     thresholds (ok < 50% · warn ≥ 50% · danger ≥ 85%). -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BoosterWallet, ManagedUsageResult, UsageRow } from '../../api/types';
import {
  formatResetAt,
  formatUsageLabel,
  moneyParts,
  usagePercent,
  usageSeverity,
} from '@moonshot-ai/app-core/lib';
import PlanUpgradeCard from './PlanUpgradeCard.vue';
import { Button, Spinner } from '@moonshot-ai/app-ui';

const props = defineProps<{
  onFetchUsage: () => Promise<ManagedUsageResult>;
}>();

const { t } = useI18n();

const loading = ref(true);
const result = ref<ManagedUsageResult | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    result.value = await props.onFetchUsage();
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const okResult = computed(() => (result.value?.kind === 'ok' ? result.value : null));
const wallet = computed<BoosterWallet | null>(() => okResult.value?.extraUsage ?? null);
const usageRows = computed<UsageRow[]>(() => {
  const ok = okResult.value;
  if (ok === null) return [];
  return ok.summary === null ? ok.limits : [ok.summary, ...ok.limits];
});
// No plan rows to show — either a truly empty answer or a wallet-only account
// (booster data renders in its own section below; this section still gets an
// explicit empty state instead of a bare bordered shell).
const hasUsageRows = computed(() => usageRows.value.length > 0);
const errorMessage = computed(() =>
  result.value?.kind === 'error' ? result.value.message : t('settings.planUsage.loadFailed'),
);

// 402/403 = the account isn't a member: the usage endpoint is off-limits, so
// the whole module swaps to the upgrade entry. SettingsDialog already gates
// the confirmed free state on the userinfo probe — this catches the window
// where the card mounted before the probe resolved.
const isFreeAccountError = computed(
  () =>
    result.value?.kind === 'error' &&
    (result.value.status === 402 || result.value.status === 403),
);

// TUI extra-usage logic: the monthly spend meter only exists when a monthly
// cap is configured; otherwise the limit row reads "Unlimited".
const hasMonthlyLimit = computed(
  () => wallet.value !== null && wallet.value.monthlyChargeLimitEnabled && wallet.value.monthlyChargeLimitCents > 0,
);

function money(cents: number, currency: string): string {
  const parts = moneyParts(cents, currency);
  return `${parts.symbol}${parts.number}`;
}

function resetHint(row: UsageRow): string {
  return row.resetAt === undefined ? '' : formatResetAt(row.resetAt, t);
}
</script>

<template>
  <!-- Free account (usage fetch rejected 402/403) — upgrade entry replaces
       the whole module. -->
  <PlanUpgradeCard v-if="isFreeAccountError" />
  <template v-else>
  <!-- Plan usage -->
  <section class="sec">
    <h3 class="sec-title">{{ t('settings.planUsage.title') }}</h3>
    <div class="pu-group">
      <!-- Loading -->
      <div v-if="loading" class="pu-row pu-state">
        <Spinner size="sm" />
      </div>

      <!-- Error (fetch failed / older daemon / not signed in) -->
      <div v-else-if="okResult === null" class="pu-row pu-state">
        <span class="pu-error-text">{{ errorMessage }}</span>
        <Button variant="ghost" size="sm" @click="load">{{ t('settings.planUsage.retry') }}</Button>
      </div>

      <!-- Empty (no plan rows; wallet-only accounts still get the Booster section below) -->
      <div v-else-if="!hasUsageRows" class="pu-row pu-state pu-empty">{{ t('settings.planUsage.empty') }}</div>

      <!-- Usage rows -->
      <div v-for="(row, index) in usageRows" v-else :key="index" class="pu-row">
        <span class="pu-main">
          <span class="pu-label">{{ formatUsageLabel(row, t) }}</span>
          <span v-if="resetHint(row)" class="pu-hint">{{ resetHint(row) }}</span>
        </span>
        <span class="pu-value">
          {{ t('settings.planUsage.usedPct', { pct: usagePercent(row.used, row.limit) }) }}
        </span>
        <span class="pu-meter" role="progressbar" :aria-valuenow="row.used" :aria-valuemax="row.limit">
          <i :class="`sev-${usageSeverity(row.used, row.limit)}`" :style="{ width: `${usagePercent(row.used, row.limit)}%` }" />
        </span>
      </div>
    </div>
  </section>

  <!-- Booster wallet (only when the account has one) -->
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
            :class="`sev-${usageSeverity(wallet.monthlyUsedCents, wallet.monthlyChargeLimitCents)}`"
            :style="{ width: `${usagePercent(wallet.monthlyUsedCents, wallet.monthlyChargeLimitCents)}%` }"
          />
        </span>
      </div>
      <div class="pu-row">
        <span class="pu-main">
          <span class="pu-label">{{ t('settings.planUsage.monthlyLimit') }}</span>
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
          {{ money(wallet.balanceCents, wallet.currency) }}<span class="pu-value-sub"> / {{ money(wallet.totalCents, wallet.currency) }}</span>
        </span>
      </div>
    </div>
  </section>
  </template>
</template>

<style scoped>
/* Mirrors the SettingsDialog section / settings-group shells so the two
   sections read as siblings of the account group. */
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
  border-top: 0.5px solid var(--color-line);
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
.pu-meter i.sev-warn { background: var(--color-warning); }
.pu-meter i.sev-danger { background: var(--color-danger); }
</style>
