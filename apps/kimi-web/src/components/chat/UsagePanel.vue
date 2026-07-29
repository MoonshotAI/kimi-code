<!-- apps/kimi-web/src/components/chat/UsagePanel.vue -->
<!-- /usage overlay — session tokens + context window from client state, plan -->
<!-- quotas + Extra Usage wallet fetched from GET /api/v1/oauth/usage on open. -->
<!-- Rendering semantics mirror the TUI usage-panel (usage-panel.ts). -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppSessionUsage, ManagedUsageResult, ManagedUsageRow } from '../../api/types';
import { formatTokens } from '../../lib/formatTokens';
import {
  countdownSeconds,
  formatCountdown,
  formatCurrency,
  usagePercent,
  usageWindowKind,
} from '../../lib/usageFormat';
import Dialog from '../ui/Dialog.vue';

const { t } = useI18n();

const props = defineProps<{
  /** Active session's cumulative usage; null when no session is open. */
  usage: AppSessionUsage | null;
  /** Managed-account plan usage; null while loading or when the fetch failed. */
  managed: ManagedUsageResult | null;
  /** Transport-level error message from the fetch, if any. */
  managedError: string | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

// The parent controls visibility with `v-if`, so the dialog is open whenever
// this component is mounted (same pattern as StatusPanel).
const open = ref(true);

// --- Session usage -----------------------------------------------------------

const sessionInput = computed(() => {
  const u = props.usage;
  if (!u) return 0;
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
});
const sessionOutput = computed(() => props.usage?.outputTokens ?? 0);
const hasSessionUsage = computed(() => sessionInput.value > 0 || sessionOutput.value > 0);
const showCost = computed(() => (props.usage?.totalCostUsd ?? 0) > 0);

// --- Context window ----------------------------------------------------------

const ctxPct = computed(() => {
  const u = props.usage;
  if (!u || u.contextLimit <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil((u.contextTokens / u.contextLimit) * 100)));
});
const showContext = computed(() => (props.usage?.contextLimit ?? 0) > 0);

// --- Plan usage (managed account) --------------------------------------------

const managedOk = computed(() => (props.managed?.kind === 'ok' ? props.managed : null));
const managedErrorText = computed(() => {
  if (props.managedError) return props.managedError;
  if (props.managed?.kind === 'error') return props.managed.message;
  return null;
});

const planRows = computed<ManagedUsageRow[]>(() => {
  const ok = managedOk.value;
  if (!ok) return [];
  const rows: ManagedUsageRow[] = [];
  if (ok.summary !== null) rows.push(ok.summary);
  rows.push(...ok.limits);
  return rows;
});

function rowLabel(row: ManagedUsageRow): string {
  const kind = usageWindowKind(row);
  if (kind.kind === 'week') return t('usage.limitWeek');
  if (kind.kind === 'hour') return t('usage.limitHour', { n: kind.n });
  if (kind.kind === 'day') return t('usage.limitDay', { n: kind.n });
  if (kind.kind === 'minute') return t('usage.limitMinute', { n: kind.n });
  return row.name ?? t('usage.limitFallback');
}

/** "resets in 2d 3h" style hint, mirroring the TUI's usageRowResetHint. */
function resetHint(row: ManagedUsageRow): string | null {
  const diffSec = countdownSeconds(row.resetAt, Date.now());
  if (diffSec === null) return null;
  if (diffSec <= 0) return t('usage.resetDone');
  return t('usage.resetsIn', { duration: formatCountdown(diffSec) });
}

// --- Extra Usage wallet ------------------------------------------------------

const extraUsage = computed(() => managedOk.value?.extraUsage ?? null);

const hasMonthlyLimit = computed(() => {
  const w = extraUsage.value;
  return w !== null && w.monthlyChargeLimitEnabled && w.monthlyChargeLimitCents > 0;
});

const monthlyPct = computed(() => {
  const w = extraUsage.value;
  if (w === null || !hasMonthlyLimit.value) return 0;
  return usagePercent({ used: w.monthlyUsedCents, limit: w.monthlyChargeLimitCents });
});
</script>

<template>
  <Dialog v-model:open="open" :title="t('usage.panelTitle')" @close="emit('close')">
    <div class="sections">
      <!-- Session usage -->
      <section class="section">
        <h3 class="section-title">{{ t('usage.sessionUsage') }}</h3>
        <dl class="rows">
          <div class="row">
            <dt>{{ t('usage.input') }}</dt>
            <dd>{{ formatTokens(sessionInput) }}</dd>
          </div>
          <div class="row">
            <dt>{{ t('usage.output') }}</dt>
            <dd>{{ formatTokens(sessionOutput) }}</dd>
          </div>
          <div v-if="showCost" class="row">
            <dt>{{ t('usage.cost') }}</dt>
            <dd>${{ (usage?.totalCostUsd ?? 0).toFixed(4) }}</dd>
          </div>
          <div v-if="!hasSessionUsage && !showCost" class="row">
            <dd class="muted">{{ t('usage.noSessionUsage') }}</dd>
          </div>
        </dl>
      </section>

      <!-- Context window -->
      <section v-if="showContext" class="section">
        <h3 class="section-title">{{ t('usage.contextWindow') }}</h3>
        <div class="bar-row">
          <span class="bar"><i :style="{ width: ctxPct + '%' }"></i></span>
          <span class="bar-pct">{{ ctxPct }}%</span>
          <span class="muted">
            {{ formatTokens(usage?.contextTokens ?? 0) }} / {{ formatTokens(usage?.contextLimit ?? 0) }}
          </span>
        </div>
      </section>

      <!-- Plan usage -->
      <section class="section">
        <h3 class="section-title">{{ t('usage.planUsage') }}</h3>
        <div v-if="loading" class="muted">{{ t('usage.loading') }}</div>
        <div v-else-if="managedErrorText" class="error">{{ managedErrorText }}</div>
        <div v-else-if="planRows.length === 0" class="muted">{{ t('usage.noUsageData') }}</div>
        <div v-else class="plan-rows">
          <div v-for="(row, i) in planRows" :key="i" class="plan-row">
            <span class="plan-label muted">{{ rowLabel(row) }}</span>
            <span class="bar"><i :style="{ width: usagePercent(row) + '%' }"></i></span>
            <span class="bar-pct">{{ t('usage.usedPct', { pct: usagePercent(row) }) }}</span>
            <span v-if="resetHint(row)" class="muted reset">{{ resetHint(row) }}</span>
          </div>
        </div>
      </section>

      <!-- Extra Usage wallet -->
      <section v-if="extraUsage" class="section">
        <h3 class="section-title">{{ t('usage.extraUsage') }}</h3>
        <div v-if="hasMonthlyLimit" class="bar-row">
          <span class="bar"><i :style="{ width: monthlyPct + '%' }"></i></span>
          <span class="bar-pct">{{ monthlyPct }}%</span>
        </div>
        <dl class="rows">
          <div class="row">
            <dt>{{ t('usage.extraUsedMonth') }}</dt>
            <dd>{{ formatCurrency(extraUsage.monthlyUsedCents, extraUsage.currency) }}</dd>
          </div>
          <div class="row">
            <dt>{{ t('usage.extraMonthlyLimit') }}</dt>
            <dd>
              {{ hasMonthlyLimit
                ? formatCurrency(extraUsage.monthlyChargeLimitCents, extraUsage.currency)
                : t('usage.extraUnlimited') }}
            </dd>
          </div>
          <div class="row">
            <dt>{{ t('usage.extraBalance') }}</dt>
            <dd>{{ formatCurrency(extraUsage.balanceCents, extraUsage.currency) }}</dd>
          </div>
        </dl>
      </section>
    </div>
  </Dialog>
</template>

<style scoped>
.sections {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.section-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--color-accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.rows {
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) 0;
  font-size: var(--text-base);
}
.row dt {
  width: 96px;
  flex: none;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.row dd {
  margin: 0;
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.muted {
  color: var(--color-text-muted);
}
.error {
  color: var(--color-danger);
}
.bar-row,
.plan-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
}
.plan-label {
  width: 110px;
  flex: none;
  font-size: var(--text-xs);
}
.bar {
  width: 80px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--color-line);
  overflow: hidden;
  flex: none;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--color-accent);
}
.bar-pct {
  font-weight: var(--weight-medium);
  white-space: nowrap;
}
.reset {
  font-size: var(--text-xs);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .plan-row {
    flex-wrap: wrap;
  }
  .plan-label {
    width: 100%;
  }
}
</style>
