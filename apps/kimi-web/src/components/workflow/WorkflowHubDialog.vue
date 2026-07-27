<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppWorkflowSummary, AppWorkflowRunRecord } from '../../api/types';
import Dialog from '../ui/Dialog.vue';
import Tabs from '../ui/Tabs.vue';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';
import WorkflowRunDialog from './WorkflowRunDialog.vue';

const { t } = useI18n();

const props = defineProps<{
  open: boolean;
  workflows: AppWorkflowSummary[];
  runs: AppWorkflowRunRecord[];
  loading: boolean;
  sessionId?: string;
}>();

const emit = defineEmits<{
  close: [];
  run: [name: string, args?: string];
  cancelRun: [runId: string];
  reload: [];
}>();

const activeTab = ref('catalog');
const selectedWorkflow = ref<AppWorkflowSummary | null>(null);
const showRunDialog = ref(false);
const runTarget = ref<string>('');

function selectWorkflow(wf: AppWorkflowSummary): void {
  selectedWorkflow.value = selectedWorkflow.value?.name === wf.name ? null : wf;
}

function openRunFor(name: string): void {
  runTarget.value = name;
  showRunDialog.value = true;
}

function handleRun(args?: string): void {
  emit('run', runTarget.value, args);
  showRunDialog.value = false;
  selectedWorkflow.value = null;
}

function handleCancelRun(runId: string): void {
  emit('cancelRun', runId);
}

function statusVariant(status: string): 'neutral' | 'warning' | 'success' | 'danger' {
  if (status === 'running') return 'warning';
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function statusLabel(status: string): string {
  const key = 'workflow.' + status;
  return t(key);
}

const sourceLabel = (source: string): string => {
  if (source === 'builtin') return 'Built-in';
  if (source === 'project') return 'Project';
  if (source === 'user') return 'User';
  return source;
};
</script>

<template>
  <Dialog
    :open="open"
    :title="t('workflow.hubTitle')"
    size="lg"
    height="fixed"
    @close="emit('close')"
  >
    <div class="wf-hub">
      <div class="wf-hub-toolbar">
        <Tabs
          :model-value="activeTab"
          :options="[
            { value: 'catalog', label: t('workflow.catalogTab') },
            { value: 'runs', label: t('workflow.runsTab') },
          ]"
          @update:model-value="activeTab = $event"
        />
        <Button size="sm" variant="secondary" @click="emit('reload')">
          <Icon name="expand" size="sm" />
          <span>{{ t('workflow.reload') }}</span>
        </Button>
      </div>

      <div class="wf-hub-body">
        <div v-if="loading" class="wf-hub-loading">
          <Spinner />
        </div>

        <!-- Catalog Tab -->
        <div v-else-if="activeTab === 'catalog'" class="wf-catalog">
          <div v-if="workflows.length === 0" class="wf-empty">
            {{ t('workflow.noWorkflows') }}
          </div>
          <div
            v-for="wf in workflows"
            :key="wf.name"
            class="wf-catalog-item"
            :class="{ expanded: selectedWorkflow?.name === wf.name }"
          >
            <button
              type="button"
              class="wf-catalog-head"
              @click="selectWorkflow(wf)"
            >
              <div class="wf-ci-left">
                <Icon name="file-text" size="md" />
                <span class="wf-ci-name">{{ wf.name }}</span>
                <Badge size="sm" variant="neutral">{{ sourceLabel(wf.source) }}</Badge>
              </div>
              <div class="wf-ci-right">
                <span class="wf-ci-phases">{{ wf.phases.length }} {{ t('workflow.phases') }}</span>
                <Icon name="chevron-right" size="sm" class="wf-ci-chevron" :class="{ open: selectedWorkflow?.name === wf.name }" />
              </div>
            </button>
            <div v-if="selectedWorkflow?.name === wf.name" class="wf-catalog-detail">
              <p class="wf-ci-desc">{{ wf.description }}</p>
              <div class="wf-ci-phases-list" v-if="wf.phases.length">
                <span class="wf-ci-phases-label">{{ t('workflow.phases') }}:</span>
                <ol class="wf-ci-phases-items">
                  <li v-for="(p, i) in wf.phases" :key="i">{{ p.title }}{{ p.detail ? ': ' + p.detail : '' }}</li>
                </ol>
              </div>
              <div class="wf-ci-actions">
                <Button variant="primary" size="sm" @click.stop="openRunFor(wf.name)">
                  <Icon name="play" size="sm" />
                  <span>{{ t('workflow.runNow') }}</span>
                </Button>
              </div>
            </div>
          </div>
        </div>

        <!-- Runs Tab -->
        <div v-else-if="activeTab === 'runs'" class="wf-runs">
          <div v-if="runs.length === 0" class="wf-empty">
            {{ t('workflow.noRuns') }}
          </div>
          <div v-for="run in runs" :key="run.runId" class="wf-run-item">
            <div class="wf-run-head">
              <span class="wf-run-name">{{ run.workflowName }}</span>
              <Badge :variant="statusVariant(run.status)" size="sm">
                {{ statusLabel(run.status) }}
              </Badge>
              <span v-if="run.phase" class="wf-run-phase-tag">{{ run.phase }}</span>
            </div>
            <div class="wf-run-meta">
              <span class="wf-run-meta-item">
                {{ t('workflow.agentCalls') }}: {{ run.agentCalls }}
              </span>
              <span class="wf-run-meta-item">
                {{ t('workflow.startedAt') }}: {{ new Date(run.startedAt).toLocaleString() }}
              </span>
            </div>
            <div v-if="run.logs.length > 0" class="wf-run-logs">
              <div v-for="(log, i) in run.logs.slice(-5)" :key="i" class="wf-run-log-line">{{ log }}</div>
            </div>
            <div v-if="run.status === 'running'" class="wf-run-actions">
              <Button size="sm" variant="danger-soft" @click="handleCancelRun(run.runId)">
                <Icon name="close" size="sm" />
                <span>{{ t('workflow.cancel') }}</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <WorkflowRunDialog
      v-if="showRunDialog"
      :open="showRunDialog"
      :workflow-name="runTarget"
      @run="handleRun"
      @close="showRunDialog = false"
    />
  </Dialog>
</template>

<style scoped>
.wf-hub {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.wf-hub-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-line);
  margin-bottom: 12px;
}
.wf-hub-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.wf-hub-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
}
.wf-empty {
  padding: 40px 16px;
  text-align: center;
  color: var(--dim);
  font-size: var(--text-sm);
}

/* Catalog */
.wf-catalog-item {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  margin-bottom: 8px;
  overflow: hidden;
}
.wf-catalog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 12px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text);
  font-size: var(--text-base);
  text-align: left;
}
.wf-catalog-head:hover {
  background: var(--color-surface-sunken);
}
.wf-ci-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.wf-ci-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-ci-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.wf-ci-phases {
  font-size: var(--text-xs);
  color: var(--dim);
}
.wf-ci-chevron {
  transition: transform 0.15s ease;
}
.wf-ci-chevron.open {
  transform: rotate(90deg);
}
.wf-catalog-detail {
  padding: 0 12px 12px;
  border-top: 1px solid var(--color-line);
}
.wf-ci-desc {
  margin: 10px 0 8px;
  font-size: var(--text-sm);
  color: var(--dim);
  line-height: 1.5;
}
.wf-ci-phases-label {
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--color-text);
}
.wf-ci-phases-items {
  margin: 4px 0 0;
  padding-left: 20px;
  font-size: var(--text-sm);
  color: var(--dim);
  line-height: 1.6;
}
.wf-ci-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}

/* Runs */
.wf-run-item {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  margin-bottom: 8px;
  padding: 10px 12px;
}
.wf-run-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.wf-run-name {
  font-weight: 500;
  font-size: var(--text-base);
}
.wf-run-phase-tag {
  font-size: var(--text-xs);
  color: var(--dim);
  background: var(--color-surface-sunken);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}
.wf-run-meta {
  display: flex;
  gap: 16px;
  font-size: var(--text-xs);
  color: var(--dim);
  margin-bottom: 6px;
}
.wf-run-logs {
  background: var(--color-surface-sunken);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  max-height: 80px;
  overflow-y: auto;
  margin-bottom: 6px;
}
.wf-run-log-line {
  font-family: var(--mono);
  font-size: var(--text-xs);
  line-height: 1.4;
  color: var(--dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-run-actions {
  display: flex;
  gap: 8px;
}
</style>
