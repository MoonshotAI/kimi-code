<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { computed, inject } from 'vue';
import { Button, Icon } from '@moonshot-ai/app-ui';
import { Markdown } from '@moonshot-ai/app-markdown';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import type { SessionPlan } from '@moonshot-ai/app-core/api';
import type {  } from '@moonshot-ai/app-core/client/types';
import { createCwdAssumedResolver } from '../turnFilePathIndex';

const props = defineProps<{
  plan?: SessionPlan;
  planModeOn?: boolean;
}>();

const { t } = useI18n();

const panelApi = inject(panelApiKey);

const client = useKimiWebClient();
const assumedFilePathResolver = computed(() => createCwdAssumedResolver(client.status.value.cwd));

const pathOnlyPlan = computed(() =>
  props.plan && !props.plan.plan && props.plan.path ? props.plan.path : undefined,
);
function openPathOnlyPlan(): void {
  if (pathOnlyPlan.value) panelApi?.openFile({ path: pathOnlyPlan.value });
}

</script>

<template>
  <div class="plan-panel">
    <template v-if="plan">
      <div v-if="plan.review?.selectedOption" class="plan-review-row">
        <span class="plan-review-label">{{ t('tools.plan.selectedOption') }}</span>
        <span>{{ plan.review.selectedOption }}</span>
      </div>
      <div v-if="plan.review?.feedback" class="plan-review-row">
        <span class="plan-review-label">{{ t('tools.plan.feedback') }}</span>
        <span class="plan-review-feedback">{{ plan.review.feedback }}</span>
      </div>
      <Markdown v-if="plan.plan" :text="plan.plan" :open-file="panelApi?.openFile" :resolve-file-path="assumedFilePathResolver" />
      <div v-if="pathOnlyPlan" class="plan-path-only">
        <span class="plan-path-hint">{{ t('tools.plan.pathOnlyHint') }}</span>
        <Button variant="text" size="xs" class="plan-path" @click="openPathOnlyPlan">{{ pathOnlyPlan }}</Button>
      </div>
    </template>
    <div v-else class="plan-empty">
      <Icon name="file-edit" size="lg" class="plan-empty-ico" />
      <span>{{ planModeOn ? t('status.planEmptyArmed') : t('status.planEmptyIdle') }}</span>
    </div>
  </div>
</template>

<style scoped>
.plan-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.plan-panel:has(> .md) {
  padding-top: var(--space-2);
}
.plan-panel .md :deep(.markdown-renderer > .node-slot:first-child) {
  padding-top: 0;
}
.plan-review-row {
  display: flex;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.plan-review-label {
  flex: none;
  color: var(--color-text-muted);
}
.plan-review-feedback {
  color: var(--color-text-muted);
}
.plan-path-only {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}
.plan-path-hint,
.plan-panel .plan-path {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  line-height: round(calc(var(--text-xs) * 1.5), 1px);
}
.plan-panel .plan-path {
  max-width: 100%;
  border-width: 0;
  justify-content: flex-start;
  text-align: start;
  white-space: normal;
  overflow-wrap: anywhere;
}
.plan-panel .plan-path:not(:disabled):hover {
  color: var(--color-text);
}
.plan-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  color: var(--color-text-faint);
  font-size: var(--text-sm);
}
.plan-empty-ico { width: var(--p-empty-ico); height: var(--p-empty-ico); color: var(--color-line-strong); }
</style>
