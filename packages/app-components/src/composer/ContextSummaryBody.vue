<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Spinner } from '@moonshot-ai/app-ui';
import type { SessionContextSummary } from '@moonshot-ai/app-core/api';
import ContextComposition from './ContextComposition.vue';

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

const { t } = useI18n();

const hasContent = computed(() => (props.snapshot?.groups ?? []).some((group) => group.tokens > 0));
</script>

<template>
  <div class="ctx-summary">
    <div class="ctx-summary-body" :class="{ 'is-refreshing': loading && snapshot }">
      <ContextComposition :snapshot="snapshot" :ctx-used="ctxUsed" :ctx-max="ctxMax" />
      <div v-if="loading && !snapshot" class="ctx-summary-loading">
        <Spinner size="sm" />
      </div>
      <div v-else-if="error && !snapshot" class="ctx-summary-error" role="alert">
        {{ error }}
      </div>
      <span v-else-if="!hasContent" class="ctx-empty-text">{{ t('inspector.noContext') }}</span>
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
.ctx-summary-stale {
  font-size: var(--text-xs);
  color: var(--color-warning);
}
.ctx-empty-text {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
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
