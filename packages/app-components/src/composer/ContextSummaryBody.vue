<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Spinner, Tooltip } from '@moonshot-ai/app-ui';
import type { SessionContextGroup, SessionContextSummary } from '@moonshot-ai/app-core/api';

const props = withDefaults(defineProps<{
  snapshot: SessionContextSummary | null;
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

const capacityRatio = computed(() => {
  const used = props.snapshot?.tokens.used ?? 0;
  const max = props.snapshot?.tokens.max ?? 0;
  return max > 0 ? Math.min(1, Math.max(0, used / max)) : 1;
});

const segments = computed(() =>
  (props.snapshot?.groups ?? []).filter((group) => group.chars > 0),
);

function groupCountLabel(group: SessionContextGroup): string {
  const countKey = `inspector.compositionCount.${group.role}`;
  return t(te(countKey) ? countKey : 'inspector.compositionCount.unknown', {
    n: group.count.toLocaleString(),
  });
}

function groupPct(group: SessionContextGroup): number {
  const total = props.snapshot?.total_chars ?? 0;
  if (total <= 0) return 0;
  return Math.round((group.chars / total) * 100);
}

function groupTooltip(group: SessionContextGroup): string {
  const chars = t('inspector.characters', { n: group.chars.toLocaleString() });
  return `${groupCountLabel(group)} · ${chars} · ${groupPct(group)}%`;
}
</script>

<template>
  <div class="ctx-summary">
    <div class="ctx-summary-body" :class="{ 'is-refreshing': loading && snapshot }">
      <div v-if="loading && !snapshot" class="ctx-summary-loading">
        <Spinner size="sm" />
      </div>
      <div v-else-if="error && !snapshot" class="ctx-summary-error" role="alert">
        {{ error }}
      </div>
      <template v-else-if="snapshot && snapshot.total_chars > 0">
        <div class="ctx-composition-bar" :aria-label="t('inspector.composition')">
          <Tooltip v-for="group in segments" :key="group.role" :text="groupTooltip(group)">
            <span
              class="ctx-composition-seg"
              :data-role="group.role"
              :style="{ width: `${(group.chars / snapshot.total_chars) * capacityRatio * 100}%` }"
            />
          </Tooltip>
        </div>
        <div class="ctx-role-list">
          <div
            v-for="group in snapshot.groups"
            :key="group.role"
            class="ctx-role-row"
            :data-role="group.role"
          >
            <span class="ctx-role-marker" />
            <span class="ctx-role-name">{{ t(`inspector.role.${group.role}`, group.role) }}</span>
            <span class="ctx-role-count">{{ groupCountLabel(group) }}</span>
            <span class="ctx-role-pct">{{ groupPct(group) }}%</span>
          </div>
        </div>
      </template>
      <div v-else class="ctx-summary-empty">
        <div class="ctx-composition-bar" />
        <span class="ctx-empty-text">{{ t('inspector.noContext') }}</span>
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
  height: var(--space-2);
  overflow: hidden;
  border-radius: var(--radius-context-segment);
  background: var(--color-fill-2);
}
.ctx-composition-seg {
  display: block;
  height: 100%;
  min-width: var(--space-2);
  border-right: var(--p-hairline) solid var(--color-bg);
  border-radius: var(--radius-context-segment);
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
  color: var(--color-text-muted);
  white-space: nowrap;
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
  flex: none;
}
.ctx-role-count {
  margin-left: auto;
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ctx-role-pct {
  width: 32px;
  text-align: right;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  flex: none;
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
