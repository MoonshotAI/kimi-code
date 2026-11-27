<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Checkbox, Icon, IconButton, Link, Spinner, Tooltip } from '@moonshot-ai/app-ui';
import { formatWorktreeSize, worktreeFailureText, type WorktreeManageRow } from '@moonshot-ai/app-client/lib';
import WorktreeOutput from './WorktreeOutput.vue';

const props = defineProps<{
  row: WorktreeManageRow;
  batchMode: boolean;
  selected: boolean;
  outputOpen: boolean;
  pending?: boolean;
}>();

const emit = defineEmits<{
  toggleSelect: [];
  openSession: [sessionId: string];
  delete: [];
  toggleOutput: [];
}>();

const { t } = useI18n();
const tr = (key: string, params?: Record<string, unknown>): string => (params === undefined ? t(key) : t(key, params));

const size = computed(() => formatWorktreeSize(props.row.sizeBytes));

const note = computed(() => {
  const row = props.row;
  if (row.noSession) return t('worktreeManage.noSession');
  return row.sessionsInUse > 1 ? t('worktreeManage.sessionsInUse', { n: row.sessionsInUse }) : '';
});

const details = computed(() => [size.value, note.value].filter((part) => part !== '').join(' · '));

const blockedHint = computed(() => (props.row.busy ? t('worktreeManage.sessionRunning') : null));

const failure = computed(() =>
  props.row.status === 'failed' ? worktreeFailureText(props.row.failureReason, tr) : null,
);

function onDelete(): void {
  if (!props.row.deletable || props.pending) return;
  emit('delete');
}

function onSelect(): void {
  if (props.row.deletable) emit('toggleSelect');
}
</script>

<template>
  <div class="manage-row" :class="{ 'is-deleting': row.status === 'deleting' }" :data-path="row.path">
    <Tooltip v-if="batchMode" :text="blockedHint">
      <span class="manage-row__check">
        <Checkbox
          :model-value="selected && row.deletable"
          :disabled="!row.deletable"
          :label="t('worktreeManage.selectWorktree', { name: row.title })"
          @update:model-value="onSelect"
        />
      </span>
    </Tooltip>
    <div class="manage-row__main">
      <div class="manage-row__title">
        <span class="manage-row__name" :class="{ 'is-directory': row.titleIsDirectory }">{{ row.title }}</span>
        <Badge v-if="row.label === 'deleted'" variant="warning" size="sm">{{ t('worktreeManage.labelDeleted') }}</Badge>
        <Badge v-else-if="row.label === 'archived'" variant="neutral" size="sm">
          {{ t('worktreeManage.labelArchived') }}
        </Badge>
      </div>
      <div class="manage-row__meta">
        <span v-if="row.branch !== undefined" class="manage-row__branch">{{ row.branch }}</span>
        <span v-if="row.branch !== undefined && details" class="manage-row__sep" aria-hidden="true"> · </span>
        <span v-if="details" class="manage-row__details">{{ details }}</span>
      </div>
      <div v-if="failure !== null" class="manage-row__failure">
        <Icon name="alert-triangle" size="sm" />
        <span>{{ failure }}</span>
        <button v-if="row.output" type="button" class="manage-row__link" :aria-expanded="outputOpen" @click="emit('toggleOutput')">
          <Link>{{ outputOpen ? t('worktreeManage.hideOutput') : t('worktreeManage.viewOutput') }}</Link>
        </button>
      </div>
      <WorktreeOutput v-if="failure !== null && outputOpen && row.output" class="manage-row__output" :text="row.output" />
    </div>
    <div class="manage-row__actions">
      <span v-if="row.status === 'deleting'" class="manage-row__deleting">
        <Spinner size="xs" />
        <span>{{ t('worktreeManage.deleting') }}</span>
      </span>
      <template v-else-if="!batchMode">
        <IconButton
          v-if="row.openSessionId"
          class="manage-row__open"
          :label="t('worktreeManage.openSession')"
          :tooltip="t('worktreeManage.openSession')"
          @click="emit('openSession', row.openSessionId)"
        >
          <Icon name="message" size="md" />
        </IconButton>
        <IconButton
          class="manage-row__delete"
          :class="{ 'is-unavailable': !row.deletable }"
          :label="t('worktreeManage.delete')"
          :tooltip="blockedHint ?? t('worktreeManage.delete')"
          :aria-disabled="!row.deletable"
          @click="onDelete"
        >
          <Icon name="trash" size="md" />
        </IconButton>
      </template>
    </div>
  </div>
</template>

<style scoped>
.manage-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  margin: 0 var(--space-4);
  border-top: var(--p-hairline) solid var(--color-line);
}
.manage-row__check {
  display: inline-flex;
  flex: none;
}
.manage-row__main {
  flex: 1;
  min-width: 0;
}
.manage-row__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.manage-row__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  color: var(--color-text);
}
.manage-row__meta {
  margin-top: var(--space-05);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.manage-row__branch { font-family: var(--font-mono); }
.manage-row__failure {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--color-danger);
}
.manage-row__link {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  cursor: pointer;
}
.manage-row__link:focus-visible {
  outline: none;
  border-radius: var(--radius-sm);
  box-shadow: var(--p-focus-ring);
}
.manage-row__output {
  margin-top: var(--space-2);
}
.manage-row__actions {
  display: flex;
  align-items: center;
  flex: none;
  gap: var(--space-1);
}
.manage-row__deleting {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.manage-row.is-deleting .manage-row__main { opacity: 0.6; }
.manage-row__delete.is-unavailable {
  opacity: 0.4;
  cursor: not-allowed;
}
.manage-row__delete.is-unavailable:hover {
  background: transparent;
  color: var(--color-text-muted);
}
</style>
