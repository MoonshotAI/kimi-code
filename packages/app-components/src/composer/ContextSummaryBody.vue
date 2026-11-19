<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Spinner, Tooltip } from '@moonshot-ai/app-ui';
import type { SessionContextGroup, SessionContextSummary } from '@moonshot-ai/app-core/api';
import { formatTokens, formatTokenShare } from '@moonshot-ai/app-core/lib';

const props = withDefaults(defineProps<{
  snapshot: SessionContextSummary | null;
  ctxUsed?: number;
  ctxMax?: number;
  loading?: boolean;
  error?: string;
  canCompact?: boolean;
  canOpenDetail?: boolean;
  showDivider?: boolean;
}>(), {
  loading: false,
  error: '',
  canCompact: false,
  canOpenDetail: false,
  showDivider: false,
});

const emit = defineEmits<{
  compact: [];
  openDetail: [];
}>();

const { t, te } = useI18n();

const usedTokens = computed(() => props.snapshot?.tokens.used ?? props.ctxUsed ?? 0);
const maxTokens = computed(() => props.snapshot?.tokens.max ?? props.ctxMax ?? 0);

const usage = computed(() => {
  if (!props.snapshot && props.ctxUsed === undefined) return null;
  const used = formatTokens(usedTokens.value);
  if (maxTokens.value <= 0) return { headline: `${t('inspector.usedLabel')} ${used}`, total: '' };
  const pct = Math.min(100, Math.ceil((usedTokens.value / maxTokens.value) * 100));
  return {
    headline: t('inspector.usedPercent', { pct }),
    total: `${used} / ${formatTokens(maxTokens.value)}`,
  };
});

function groupCountLabel(group: SessionContextGroup): string {
  const countKey = `inspector.compositionCount.${group.role}`;
  return t(te(countKey) ? countKey : 'inspector.compositionCount.unknown', {
    n: group.count.toLocaleString(),
  });
}

const rows = computed(() => {
  const groups = (props.snapshot?.groups ?? []).filter((group) => group.tokens > 0);
  const scale = maxTokens.value > 0
    ? maxTokens.value
    : groups.reduce((sum, group) => sum + group.tokens, 0);
  return groups
    .toSorted((a, b) => b.tokens - a.tokens)
    .map((group) => ({
      role: group.role,
      name: t(`inspector.role.${group.role}`, group.role),
      count: groupCountLabel(group),
      tokens: formatTokens(group.tokens),
      share: maxTokens.value > 0 ? formatTokenShare(group.tokens, maxTokens.value) : '',
      width: `${(group.tokens / scale) * 100}%`,
    }));
});
</script>

<template>
  <div class="ctx-summary">
    <div class="ctx-summary-body" :class="{ 'is-refreshing': loading && snapshot }">
      <div v-if="usage" class="ctx-usage">
        <span class="ctx-usage-headline">{{ usage.headline }}</span>
        <span v-if="usage.total" class="ctx-usage-total">{{ usage.total }}</span>
      </div>
      <div v-if="loading && !snapshot" class="ctx-summary-loading">
        <Spinner size="sm" />
      </div>
      <div v-else-if="error && !snapshot" class="ctx-summary-error" role="alert">
        {{ error }}
      </div>
      <template v-else-if="rows.length > 0">
        <div class="ctx-composition-bar" :aria-label="t('inspector.composition')">
          <Tooltip v-for="row in rows" :key="row.role" :text="`${row.name} · ${row.tokens}`">
            <span class="ctx-composition-seg" :data-role="row.role" :style="{ width: row.width }" />
          </Tooltip>
        </div>
        <div class="ctx-role-list">
          <div v-for="row in rows" :key="row.role" class="ctx-role-row" :data-role="row.role">
            <span class="ctx-role-marker" />
            <Tooltip :text="row.count">
              <span class="ctx-role-name" tabindex="0">{{ row.name }}</span>
            </Tooltip>
            <span class="ctx-role-tokens">{{ row.tokens }}</span>
            <span v-if="row.share" class="ctx-role-share">{{ row.share }}</span>
          </div>
        </div>
      </template>
      <div v-else class="ctx-summary-empty">
        <div class="ctx-composition-bar" />
        <span class="ctx-empty-text">{{ t('inspector.noContext') }}</span>
      </div>
      <div v-if="error && snapshot" class="ctx-summary-stale" role="status">
        {{ t('inspector.staleSummary') }}
      </div>
    </div>

    <div v-if="showDivider" class="ctx-summary-divider" />

    <div class="ctx-summary-actions">
      <Button
        variant="secondary"
        size="xs"
        class="ctx-summary-btn"
        :disabled="!canCompact"
        @click="emit('compact')"
      >
        {{ t('inspector.compactContext') }}
      </Button>
      <Button
        v-if="canOpenDetail"
        variant="secondary"
        size="xs"
        class="ctx-summary-btn"
        @click="emit('openDetail')"
      >
        {{ t('inspector.viewDetails') }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
.ctx-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-family: var(--font-ui);
}
.ctx-summary [data-role="system"] { --context-color: var(--color-text-muted); }
.ctx-summary [data-role="definition"] { --context-color: var(--color-context-definition); }
.ctx-summary [data-role="user"] { --context-color: var(--color-info); }
.ctx-summary [data-role="assistant"] { --context-color: var(--color-context-assistant); }
.ctx-summary [data-role="tool"] { --context-color: var(--color-orange); }

.ctx-summary-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.ctx-summary-body.is-refreshing {
  opacity: 0.5;
}
.ctx-usage {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ctx-usage-headline {
  font-size: var(--ui-font-size);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.ctx-usage-total {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.ctx-summary-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-2) 0;
}
.ctx-summary-error {
  font-size: var(--text-xs);
  color: var(--color-danger);
  overflow-wrap: anywhere;
}
.ctx-summary-stale {
  font-size: var(--text-xs);
  color: var(--color-warning);
}
.ctx-summary-empty {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}
.ctx-empty-text {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}

.ctx-composition-bar {
  display: flex;
  height: var(--space-1-5);
  overflow: hidden;
  border-radius: var(--radius-context-segment);
  background: var(--color-fill-2);
}
.ctx-composition-seg {
  display: block;
  flex: none;
  height: 100%;
  min-width: var(--space-1);
  background: var(--context-color, var(--color-text-faint));
}

.ctx-role-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.ctx-role-row {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--text-xs);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ctx-role-marker {
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-context-segment);
  background: var(--context-color, var(--color-text-faint));
  flex: none;
}
.ctx-role-name {
  color: var(--color-text);
  text-decoration: underline dotted var(--color-text-faint);
  text-underline-offset: 3px;
  cursor: default;
  border-radius: var(--radius-xs);
}
.ctx-role-name:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.ctx-role-tokens {
  margin-left: auto;
  color: var(--color-text-muted);
}
.ctx-role-share {
  width: 40px;
  flex: none;
  text-align: right;
  color: var(--color-text);
}

.ctx-summary-divider {
  height: var(--p-hairline);
  background: var(--color-line);
}
.ctx-summary-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.ctx-summary-btn {
  flex: 1;
}
</style>
