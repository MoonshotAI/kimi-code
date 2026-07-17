<!-- apps/kimi-web/src/components/chat/ContextUsagePanel.vue -->
<!-- Composer context meter + managed-account usage limits. The trigger is the
     circular context ring (hover: the original tooltip); clicking it opens a
     fixed-position panel with the context size and — when the session's model
     runs on the managed provider — the managed quota rows (weekly summary,
     rolling 5h limits, …) and the booster wallet. Quota data is fetched on
     open and refreshed every 60s while the panel is open; the cache is dropped
     on close so reopening always revalidates against the current login. -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ContextRing from '../ui/ContextRing.vue';
import Tooltip from '../ui/Tooltip.vue';
import Spinner from '../ui/Spinner.vue';
import { getKimiWebApi } from '../../api';
import type { AppBoosterWallet, AppManagedUsage } from '../../api/types';
import type { ConversationStatus } from '../../types';
import { formatTokens } from '../../lib/formatTokens';
import { buildUsageRows, formatUsageMoney } from '../../lib/usageFormat';

const props = defineProps<{
  status: ConversationStatus;
  /** Provider id of the session's current model — the quota section only
   *  applies to the managed provider; undefined while the catalog loads. */
  provider?: string;
}>();
const emit = defineEmits<{ open: [] }>();

const { t, locale } = useI18n();

// Mirrors the TUI's isManagedUsageProvider: quota rows only exist for the
// managed OAuth account; other providers show the context meter alone and the
// usage endpoint is never called.
const MANAGED_PROVIDER = 'managed:kimi-code';
const quotaEnabled = computed(() => props.provider === MANAGED_PROVIDER);

// ---------------------------------------------------------------------------
// Trigger — context ring + tooltip (moved from Composer.vue)
// ---------------------------------------------------------------------------

// Clamped to 0–100: ctxUsed can momentarily exceed ctxMax (estimates), and
// ctxMax can be 0 before the first status fetch — both broke the ring. ceil
// (not round) so a session under 0.5% usage still shows a sliver of arc.
const pct = computed(() => {
  const max = props.status.ctxMax;
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil((props.status.ctxUsed / max) * 100)));
});

const ctxTooltip = computed(() =>
  t('status.ctxTooltip', {
    used: formatTokens(props.status.ctxUsed),
    max: formatTokens(props.status.ctxMax),
    pct: pct.value,
  }),
);

const ctxValue = computed(() =>
  t('status.statusContextValue', {
    used: formatTokens(props.status.ctxUsed),
    max: formatTokens(props.status.ctxMax),
    pct: pct.value,
  }),
);

// ---------------------------------------------------------------------------
// Panel open/close — mirrors the Composer modes-menu pattern (position:fixed
// anchored above the trigger, document listeners registered after open).
// ---------------------------------------------------------------------------

const open = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});
let documentListenerTimer: ReturnType<typeof setTimeout> | undefined;

const REFRESH_INTERVAL_MS = 60_000;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function startRefreshLoop(): void {
  if (!open.value || !quotaEnabled.value || refreshTimer !== undefined) return;
  void refresh();
  refreshTimer = setInterval(() => {
    void refresh();
  }, REFRESH_INTERVAL_MS);
}

function stopRefreshLoop(): void {
  if (refreshTimer === undefined) return;
  clearInterval(refreshTimer);
  refreshTimer = undefined;
}

function togglePanel(): void {
  if (open.value) {
    closePanel();
    return;
  }
  // Let the composer close its own menus so toolbar popups never overlap.
  emit('open');
  const r = triggerRef.value?.getBoundingClientRect();
  if (r) {
    panelStyle.value = {
      right: `${String(Math.round(window.innerWidth - r.right))}px`,
      bottom: `${String(Math.round(window.innerHeight - r.top + 8))}px`,
    };
  }
  open.value = true;
  startRefreshLoop();
  void nextTick(() => panelRef.value?.focus());
  documentListenerTimer = setTimeout(() => {
    documentListenerTimer = undefined;
    if (!open.value) return;
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onDocKeydown);
  }, 0);
}

function closePanel(restoreFocus = false): void {
  open.value = false;
  cancelDocumentListenerRegistration();
  invalidateUsage();
  stopRefreshLoop();
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onDocKeydown);
  if (restoreFocus) void nextTick(() => triggerRef.value?.focus());
}

defineExpose({ close: closePanel });

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (triggerRef.value?.contains(target) || panelRef.value?.contains(target)) return;
  closePanel();
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    closePanel(true);
  }
}

function cancelDocumentListenerRegistration(): void {
  if (documentListenerTimer === undefined) return;
  clearTimeout(documentListenerTimer);
  documentListenerTimer = undefined;
}

onUnmounted(() => {
  cancelDocumentListenerRegistration();
  invalidateUsage();
  stopRefreshLoop();
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onDocKeydown);
});

// ---------------------------------------------------------------------------
// Usage data — `loading` only covers the initial fetch; the 60s revalidation
// is silent so the panel content never flickers. The in-flight guard keeps
// the tick and the open-refresh from stacking requests.
// ---------------------------------------------------------------------------

const usage = ref<AppManagedUsage | null>(null);
const loading = ref(false);
let inFlight: Promise<void> | null = null;
let usageGeneration = 0;

function invalidateUsage(): void {
  usageGeneration += 1;
  usage.value = null;
  loading.value = false;
  inFlight = null;
}

function refresh(): Promise<void> {
  if (inFlight !== null) return inFlight;
  if (usage.value === null) loading.value = true;
  const generation = usageGeneration;
  let request!: Promise<void>;
  request = (async () => {
    try {
      const result = await getKimiWebApi().getManagedUsage();
      if (generation === usageGeneration && open.value && quotaEnabled.value) {
        usage.value = result;
      }
    } finally {
      if (generation === usageGeneration) loading.value = false;
      if (inFlight === request) inFlight = null;
    }
  })();
  inFlight = request;
  return request;
}

watch(quotaEnabled, (enabled) => {
  if (!open.value) return;
  invalidateUsage();
  if (enabled) startRefreshLoop();
  else stopRefreshLoop();
});

const usageRows = computed(() =>
  usage.value?.kind === 'ok' ? buildUsageRows(usage.value, t) : [],
);

const extraUsage = computed<AppBoosterWallet | null>(() =>
  usage.value?.kind === 'ok' ? usage.value.extraUsage : null,
);
const usageHasDetails = computed(
  () => usageRows.value.length > 0 || extraUsage.value !== null,
);

// Localized copy keyed off the stable error code — the raw upstream
// `message` (English, sometimes technical) is never rendered.
const errorText = computed(() => {
  if (usage.value?.kind !== 'error') return '';
  if (usage.value.code === 'unauthenticated') return t('status.usageNotLoggedIn');
  if (usage.value.code === 'route_unavailable') return t('status.usageRouteUnavailable');
  return t('status.usageUnavailable');
});

const monthlyLimitText = computed(() => {
  const extra = extraUsage.value;
  if (extra === null) return '';
  if (!extra.monthlyChargeLimitEnabled || extra.monthlyChargeLimitCents <= 0) {
    return t('status.usageUnlimited');
  }
  return formatUsageMoney(extra.monthlyChargeLimitCents, extra.currency, locale.value);
});

function money(cents: number, currency: string): string {
  return formatUsageMoney(cents, currency, locale.value);
}
</script>

<template>
  <Tooltip :text="ctxTooltip" :disabled="open">
    <button
      ref="triggerRef"
      type="button"
      class="ctx-group"
      :class="{ open }"
      :aria-label="ctxTooltip"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click.stop="togglePanel"
      @keydown.enter.prevent="togglePanel"
      @keydown.space.prevent="togglePanel"
    >
      <ContextRing :pct="pct" />
    </button>
  </Tooltip>

  <div
    v-if="open"
    ref="panelRef"
    class="usage-panel"
    :style="panelStyle"
    role="dialog"
    :aria-label="t('status.usageTitle')"
    tabindex="-1"
  >
    <div class="up-head">
      <span class="up-title">{{ t('status.usageTitle') }}</span>
    </div>

    <div class="up-row">
      <span class="up-label">{{ t('status.statusContext') }}</span>
      <span class="up-value">{{ ctxValue }}</span>
    </div>
    <div class="up-track"><div class="up-fill" :style="{ width: `${String(pct)}%` }" /></div>

    <template v-if="quotaEnabled">
      <template v-if="usage?.kind === 'ok'">
        <template v-if="usageRows.length > 0">
          <div class="up-divider" />
          <div v-for="row in usageRows" :key="row.key" class="up-limit">
            <div class="up-row">
              <span class="up-label">{{ row.label }}</span>
              <span class="up-value">{{ row.valueText }}</span>
            </div>
            <div class="up-track"><div class="up-fill" :style="{ width: `${String(row.pct)}%` }" /></div>
            <div v-if="row.resetHint" class="up-hint">{{ row.resetHint }}</div>
          </div>
        </template>

        <template v-if="extraUsage">
          <div class="up-divider" />
          <div class="up-subtitle">{{ t('status.usageExtraTitle') }}</div>
          <div class="up-row">
            <span class="up-label">{{ t('status.usageBalance') }}</span>
            <span class="up-value">{{ money(extraUsage.balanceCents, extraUsage.currency) }}</span>
          </div>
          <div class="up-row">
            <span class="up-label">{{ t('status.usageMonthlyUsed') }}</span>
            <span class="up-value">{{ money(extraUsage.monthlyUsedCents, extraUsage.currency) }}</span>
          </div>
          <div class="up-row">
            <span class="up-label">{{ t('status.usageMonthlyLimit') }}</span>
            <span class="up-value">{{ monthlyLimitText }}</span>
          </div>
        </template>

        <div v-if="!usageHasDetails" class="up-empty">
          {{ t('status.usageEmpty') }}
        </div>
      </template>

      <div v-else-if="usage?.kind === 'error'" class="up-error">
        <span>{{ errorText }}</span>
      </div>

      <div v-else-if="loading" class="up-loading">
        <Spinner size="sm" :label="t('status.usageLoading')" />
        <span>{{ t('status.usageLoading') }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Trigger — circular ring. Focusable for keyboard / switch access, so it
   needs a focus ring; now clickable, so it also gets a hover wash. */
.ctx-group {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 2px 4px;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.ctx-group:hover {
  background: var(--color-hover);
}
.ctx-group:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

.usage-panel {
  position: fixed;
  z-index: var(--z-dropdown);
  min-width: 240px;
  width: max-content;
  max-width: calc(100vw - var(--space-8));
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-family: var(--font-ui);
}

.up-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.up-title {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.up-subtitle {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--muted);
}

.up-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
}
.up-label {
  font-size: var(--ui-font-size);
  color: var(--dim);
  line-height: var(--leading-normal);
}
.up-value {
  font-size: var(--ui-font-size);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  line-height: var(--leading-normal);
  white-space: nowrap;
}

.up-track {
  height: 3px;
  border-radius: 999px;
  background: var(--color-line);
  overflow: hidden;
}
.up-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--color-accent);
  transition: width 0.3s ease;
}

.up-limit {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.up-hint {
  font-size: var(--text-xs);
  color: var(--muted);
  line-height: var(--leading-normal);
}

.up-divider {
  height: 1px;
  background: var(--color-line);
  margin: 2px 0;
}

.up-loading,
.up-error,
.up-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--ui-font-size);
  color: var(--muted);
  line-height: var(--leading-normal);
}
</style>
