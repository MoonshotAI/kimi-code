<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { ContextSummaryBody } from '@moonshot-ai/app-components/support';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import type { SessionContextInfoState } from '@moonshot-ai/app-client/stores';
import { formatTokens } from '@moonshot-ai/app-core/lib';

const props = withDefaults(defineProps<{
  state?: SessionContextInfoState;
  ctxUsed?: number;
  ctxMax?: number;
  canCompact?: boolean;
}>(), {
  canCompact: false,
});

const emit = defineEmits<{
  compact: [];
}>();

const { t } = useI18n();
const panelApi = inject(panelApiKey, undefined);
const expanded = ref(true);

const snapshot = computed(() =>
  props.state && props.state.status !== 'error' ? props.state.value ?? null : null,
);
const loading = computed(() => props.state?.status === 'loading');
const error = computed(() => props.state?.status === 'error' ? props.state.message : '');
const canOpenDetail = computed(() => Boolean(panelApi?.openContext));

const usageLabel = computed(() => {
  const used = snapshot.value?.tokens.used ?? props.ctxUsed ?? 0;
  const max = snapshot.value?.tokens.max ?? props.ctxMax ?? 0;
  if (max <= 0 && used <= 0 && !snapshot.value) return '';
  if (max > 0) {
    return t('inspector.usageSummary', {
      used: formatTokens(used),
      remaining: formatTokens(Math.max(0, max - used)),
    });
  }
  return `${t('inspector.usedLabel')} ${formatTokens(used)}`;
});
</script>

<template>
  <section class="si-context" :class="{ 'is-collapsed': !expanded }">
    <button class="sic-heading" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="sic-title">{{ t('inspector.title') }}</span>
      <span v-if="usageLabel" class="sic-usage">{{ usageLabel }}</span>
      <Icon class="sic-chevron" :class="{ collapsed: !expanded }" name="chevron-down" size="sm" />
    </button>

    <ContextSummaryBody
      v-if="expanded"
      class="sic-body"
      :snapshot="snapshot"
      :loading="loading"
      :error="error"
      :can-compact="canCompact"
      :can-open-detail="canOpenDetail"
      @compact="emit('compact')"
      @open-detail="panelApi?.openContext?.()"
    />
  </section>
</template>

<style scoped>
.si-context {
  position: relative;
  min-width: 0;
  padding: var(--space-3) var(--space-4) var(--space-4);
}
.si-context.is-collapsed {
  padding-bottom: var(--space-3);
}
.sic-heading {
  width: 100%;
  min-width: 0;
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}
.sic-heading:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.sic-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}
.sic-usage {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.sic-chevron {
  flex: none;
  color: var(--color-text-faint);
  transition: transform var(--duration-fast) var(--ease-out);
}
.sic-chevron.collapsed { transform: rotate(-90deg); }
.sic-body { margin-top: var(--space-1-5); }
</style>
