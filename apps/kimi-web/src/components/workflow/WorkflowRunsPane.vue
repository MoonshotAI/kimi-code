<!-- Pane listing active and recent workflow runs, shown in the dock panel.
     Follows the same visual pattern as TasksPane.vue. -->
<script setup lang="ts">
import { reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppWorkflowRunRecord, AppWorkflowRunStatus } from '../../api/types';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import Icon from '../ui/Icon.vue';

const props = defineProps<{
  runs: AppWorkflowRunRecord[];
}>();

const emit = defineEmits<{
  cancel: [runId: string];
}>();

const { t } = useI18n();

// Which run rows are expanded (showing their logs). Toggle on click.
const expandedIds = reactive(new Set<string>());

function hasDetail(run: AppWorkflowRunRecord): boolean {
  return run.logs.length > 0;
}

function toggleExpand(run: AppWorkflowRunRecord): void {
  if (!hasDetail(run)) return;
  if (expandedIds.has(run.runId)) expandedIds.delete(run.runId);
  else expandedIds.add(run.runId);
}

function statusVariant(status: AppWorkflowRunStatus): 'warning' | 'success' | 'danger' | 'neutral' {
  if (status === 'running') return 'warning';
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'neutral';
  return 'neutral';
}

function statusLabel(status: AppWorkflowRunStatus): string {
  if (status === 'running') return t('workflow.running');
  if (status === 'completed') return t('workflow.completed');
  if (status === 'failed') return t('workflow.failed');
  if (status === 'cancelled') return t('workflow.cancelled');
  return status;
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function elapsed(run: AppWorkflowRunRecord): string {
  const end = run.endedAt ?? Date.now();
  const diff = end - run.startedAt;
  return formatTime(Math.max(0, diff));
}

function startedLabel(run: AppWorkflowRunRecord): string {
  const d = new Date(run.startedAt);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
</script>

<template>
  <div class="wrpane">
    <!-- Header: title + count -->
    <div class="wrp-head">
      <span class="wrp-title">{{ t('workflow.runsTab') }}</span>
      <span class="wrp-count">{{ runs.length }}</span>
    </div>

    <div class="wrp-list">
      <div v-if="runs.length === 0" class="wrp-empty">{{ t('workflow.noRuns') }}</div>

      <template v-else>
        <div
          v-for="run in runs"
          :key="run.runId"
          class="wrp-row"
          :class="{
            done: run.status === 'completed',
            fail: run.status === 'failed',
            cancelled: run.status === 'cancelled',
            expandable: hasDetail(run),
          }"
        >
          <div class="wrp-main" :role="hasDetail(run) ? 'button' : undefined" @click="toggleExpand(run)">
            <Icon v-if="run.status === 'running'" class="wrp-icon wrp-icon--running" name="bolt" size="sm" />
            <Icon v-else-if="run.status === 'completed'" class="wrp-icon wrp-icon--done" name="check" size="sm" />
            <Icon v-else-if="run.status === 'failed'" class="wrp-icon wrp-icon--fail" name="alert-triangle" size="sm" />
            <Icon v-else class="wrp-icon wrp-icon--cancelled" name="close" size="sm" />

            <span class="wrp-name">{{ run.workflowName }}</span>

            <Badge :variant="statusVariant(run.status)" size="sm">
              {{ statusLabel(run.status) }}
            </Badge>

            <span v-if="run.phase" class="wrp-phase">{{ run.phase }}</span>

            <span class="wrp-time">{{ run.status === 'running' ? startedLabel(run) : elapsed(run) }}</span>

            <Button
              v-if="run.status === 'running'"
              size="sm"
              variant="danger-soft"
              @click.stop="emit('cancel', run.runId)"
            >
              <Icon name="stop" size="sm" />
              <span>{{ t('workflow.cancel') }}</span>
            </Button>

            <Icon
              v-if="hasDetail(run)"
              class="wrp-chevron"
              :class="{ open: expandedIds.has(run.runId) }"
              name="chevron-right"
              size="sm"
            />
          </div>

          <div v-if="expandedIds.has(run.runId) && hasDetail(run)" class="wrp-detail">
            <div class="wrp-logbox">
              <pre class="wrp-pre"><code>
                <span v-for="(line, i) in run.logs" :key="i" class="wrp-line">{{ line }}</span>
              </code></pre>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wrpane {
  padding: 14px 18px 10px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ── Header ─────────────────────────────────────────────── */
.wrp-head {
  border-top: 1px solid var(--line);
  padding-top: 10px;
  margin-bottom: 8px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.wrp-title {
  color: var(--color-accent-hover);
  font-weight: 500;
  font-size: var(--text-base);
  text-transform: capitalize;
}
.wrp-count {
  color: var(--muted);
  font-size: var(--text-base);
}

/* ── List ──────────────────────────────────────────────── */
.wrp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wrp-row {
  padding: 4px 0;
}
.wrp-row.done .wrp-name {
  color: var(--muted);
  text-decoration: line-through;
}
.wrp-row.fail .wrp-name {
  color: var(--color-danger);
}
.wrp-row.cancelled .wrp-name {
  color: var(--muted);
}

.wrp-main {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--text-base);
}
.wrp-row.expandable > .wrp-main {
  cursor: pointer;
  border-radius: 4px;
}
.wrp-row.expandable > .wrp-main:hover {
  background: var(--panel2);
}

/* ── Status icons ──────────────────────────────────────── */
.wrp-icon { flex: none; }
.wrp-icon--running { color: var(--color-warning); }
.wrp-icon--done { color: var(--color-success); }
.wrp-icon--fail { color: var(--color-danger); }
.wrp-icon--cancelled { color: var(--muted); }

/* ── Chevron ───────────────────────────────────────────── */
.wrp-chevron {
  flex: none;
  color: var(--muted);
  transition: transform 0.12s;
}
.wrp-chevron.open {
  transform: rotate(90deg);
}

/* ── Text columns ──────────────────────────────────────── */
.wrp-name {
  color: var(--color-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wrp-phase {
  flex: none;
  font-size: var(--text-xs);
  color: var(--dim);
  background: var(--color-surface-sunken);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  white-space: nowrap;
}

.wrp-time {
  flex: none;
  font-size: var(--text-base);
  color: var(--muted);
  white-space: nowrap;
}

/* ── Empty state ───────────────────────────────────────── */
.wrp-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--faint);
  font-size: var(--ui-font-size-sm);
}

/* ── Expanded detail (logs) ────────────────────────────── */
.wrp-detail {
  margin: 4px 0 0 23px;
}

.wrp-logbox {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
}

.wrp-pre {
  margin: 0;
  padding: 6px 10px;
  max-height: 320px;
  overflow: auto;
  contain: layout paint;
}
.wrp-pre code {
  display: block;
  font-family: var(--mono);
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--dim);
  white-space: pre-wrap;
  word-break: break-word;
}
.wrp-line {
  display: block;
}

/* ── Mobile ────────────────────────────────────────────── */
@media (max-width: 640px) {
  .wrpane { padding: 14px 14px 16px; }
  .wrp-main { flex-wrap: wrap; row-gap: 4px; }
  .wrp-name { font-size: var(--ui-font-size-sm); }
  .wrp-detail { margin-left: 0; }
  .wrp-pre { font-size: var(--ui-font-size-xs); }
}
</style>
