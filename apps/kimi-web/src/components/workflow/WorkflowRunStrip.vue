<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppWorkflowRunRecord } from '../../api/types';
import Card from '../ui/Card.vue';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';

const props = defineProps<{
  run: AppWorkflowRunRecord | null;
}>();

const emit = defineEmits<{
  cancel: [runId: string];
  poll: [];
}>();

const { t } = useI18n();
let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  pollTimer = setInterval(() => emit('poll'), 2000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

function statusVariant(status: string): 'neutral' | 'warning' | 'success' | 'danger' {
  if (status === 'running') return 'warning';
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function statusLabel(status: string): string {
  if (status === 'running') return t('workflow.running');
  if (status === 'completed') return t('workflow.completed');
  if (status === 'failed') return t('workflow.failed');
  if (status === 'cancelled') return t('workflow.cancelled');
  return status;
}
</script>

<template>
  <Card v-if="run" class="wf-run-strip">
    <template #head>
      <div class="wf-run-row">
        <Icon class="wf-run-icon" name="settings" size="md" />
        <span class="wf-run-label">{{ t('workflow.stripRunning') }}</span>
        <span class="wf-run-name">{{ run.workflowName }}</span>
        <Badge :variant="statusVariant(run.status)" size="sm">
          {{ statusLabel(run.status) }}
        </Badge>
        <span class="wf-run-phase" v-if="run.phase">{{ run.phase }}</span>
        <Button size="sm" variant="danger-soft" @click="emit('cancel', run.runId)">
          <Icon name="close" size="sm" />
          <span>{{ t('workflow.cancel') }}</span>
        </Button>
      </div>
    </template>
  </Card>
</template>

<style scoped>
.wf-run-strip {
  margin-top: 8px;
}
.wf-run-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  width: 100%;
  box-sizing: border-box;
}
.wf-run-icon {
  flex: none;
  color: var(--color-warning);
}
.wf-run-label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
}
.wf-run-name {
  font-size: var(--text-sm);
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.wf-run-phase {
  font-size: var(--text-xs);
  color: var(--dim);
  background: var(--color-surface-sunken);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  white-space: nowrap;
}
</style>
