<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Checkbox } from '@moonshot-ai/app-ui';
import type { WorktreeDeleteDialogState } from '@moonshot-ai/app-client/composables';
import {
  worktreeDeleteRows,
  worktreeRemovalStateText,
  worktreeRemovalSummaryText,
  worktreeSessionDeleteRows,
  type WorktreeDeleteListItem,
  type WorktreeDeleteRow,
  type WorktreeRemovalProgress,
} from '@moonshot-ai/app-client/lib';
import ConfirmDialog from '../dialogs/ConfirmDialog.vue';
import type { ConfirmDialogCancelSource, ConfirmDialogRow } from '../dialogs/confirmDialogRow';
import ManageDeleteList from './ManageDeleteList.vue';

const props = defineProps<{
  state: WorktreeDeleteDialogState;
  progress: WorktreeRemovalProgress | null;
}>();

const emit = defineEmits<{
  setDeleteBranch: [value: boolean];
  confirm: [];
  retry: [];
  close: [];
}>();

const { t } = useI18n();
const tr = (key: string, params?: Record<string, unknown>): string => (params === undefined ? t(key) : t(key, params));

type View = 'confirm' | 'progress' | 'result' | 'session';

const view = computed<View>(() => (props.state.kind === 'session' ? 'session' : props.state.phase));

const batch = computed(() => {
  const state = props.state;
  if (state.kind === 'session') return false;
  return state.phase === 'confirm' ? state.targets.length > 1 : (props.progress?.total ?? 0) > 1;
});

const title = computed(() => {
  if (props.state.kind === 'session') return t('sidebar.deleteConfirmTitle');
  return t(batch.value ? 'worktreeManage.dialogTitleBatch' : 'worktreeManage.dialogTitle');
});

const copyRows = computed<WorktreeDeleteRow[]>(() => {
  const state = props.state;
  if (state.kind === 'session') {
    return worktreeSessionDeleteRows(
      { title: state.title, otherSessions: state.otherSessions, risk: state.risk, deleteBranch: state.deleteBranch },
      tr,
    );
  }
  return state.phase === 'confirm' ? worktreeDeleteRows(state.targets, state.deleteBranch, tr) : [];
});

const rows = computed<ConfirmDialogRow[]>(() => {
  const progress = props.progress;
  if (view.value === 'progress' && progress !== null) {
    return [
      {
        key: 'progress',
        icon: 'refresh',
        spinning: true,
        text: t('worktreeManage.progressTitle'),
        trailing: t('worktreeManage.progressCount', { done: progress.completed, total: progress.total }),
      },
    ];
  }
  if (view.value === 'result' && progress !== null) {
    return [
      {
        key: 'result',
        icon: 'alert-triangle',
        tone: 'warning',
        text: worktreeRemovalSummaryText(progress.items, tr),
      },
    ];
  }
  return copyRows.value;
});

const listItems = computed<WorktreeDeleteListItem[]>(() => {
  const progress = props.progress;
  if ((view.value === 'progress' || view.value === 'result') && progress !== null) {
    return progress.items.map((item) => ({
      key: item.path,
      name: item.name,
      nameIsDirectory: item.nameIsDirectory,
      state: item.state,
      stateText: worktreeRemovalStateText(item.state, tr),
    }));
  }
  return copyRows.value.find((row) => row.items !== undefined)?.items ?? [];
});

const branchOption = computed<string | null>(() => {
  const state = props.state;
  if (state.kind === 'session') {
    if (state.branch === undefined || state.otherSessions > 0) return null;
    return t('worktreeManage.alsoDeleteNamedBranch', { branch: state.branch });
  }
  if (state.phase !== 'confirm' || !state.targets.some((target) => target.branch !== undefined)) return null;
  return t('worktreeManage.alsoDeleteBranch');
});

const deleteBranch = computed(() => {
  const state = props.state;
  return state.kind === 'session' || state.phase === 'confirm' ? state.deleteBranch : false;
});

const confirmLabel = computed(() => {
  const state = props.state;
  if (state.kind === 'session') return t('sidebar.deleteConfirmButton');
  if (state.phase !== 'confirm') {
    return t(state.phase === 'progress' ? 'worktreeManage.continueInBackground' : 'worktreeManage.done');
  }
  return batch.value
    ? t('worktreeManage.confirmDeleteBatch', { n: state.targets.length })
    : t('worktreeManage.confirmDelete');
});

const cancelLabel = computed(() => (view.value === 'result' ? t('worktreeManage.retryFailed') : t('common.cancel')));

const variant = computed<'primary' | 'danger' | 'secondary'>(() => {
  if (view.value === 'progress') return 'secondary';
  return view.value === 'result' ? 'primary' : 'danger';
});

const loading = computed(() => props.state.kind === 'session' && props.state.busy);

function onConfirm(): void {
  if (view.value === 'progress' || view.value === 'result') emit('close');
  else emit('confirm');
}

function onCancel(source: ConfirmDialogCancelSource): void {
  if (view.value === 'result' && source === 'button') emit('retry');
  else emit('close');
}
</script>

<template>
  <ConfirmDialog
    :open="true"
    :title="title"
    :rows="rows"
    :confirm-label="confirmLabel"
    :cancel-label="cancelLabel"
    :variant="variant"
    :loading="loading"
    :hide-cancel="view === 'progress'"
    @confirm="onConfirm"
    @cancel="onCancel"
  >
    <template #after-row="{ index }">
      <ManageDeleteList v-if="index === 0 && listItems.length > 0" :items="listItems" />
    </template>
    <div v-if="branchOption !== null" class="manage-delete__option">
      <Checkbox :model-value="deleteBranch" :disabled="loading" @update:model-value="emit('setDeleteBranch', $event)">
        {{ branchOption }}
      </Checkbox>
    </div>
  </ConfirmDialog>
</template>

<style scoped>
.manage-delete__option {
  margin-top: var(--space-4);
}
.manage-delete__option :deep(.ui-check__label) {
  overflow-wrap: anywhere;
}
</style>
