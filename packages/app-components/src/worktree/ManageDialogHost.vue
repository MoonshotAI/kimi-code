<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorktreeManageDialogs } from '@moonshot-ai/app-client/composables';
import ConfirmDialog from '../dialogs/ConfirmDialog.vue';
import type { ConfirmDialogCancelSource, ConfirmDialogRow } from '../dialogs/confirmDialogRow';
import ManageDeleteDialog from './ManageDeleteDialog.vue';

const { t } = useI18n();
const {
  deleteDialog,
  deleteProgress,
  projectPrompt,
  setDeleteBranch,
  confirmDeletion,
  retryFailedDeletion,
  closeDeleteDialog,
  answerExistingWorktreeProject,
} = useWorktreeManageDialogs();

const promptRows = computed<ConfirmDialogRow[]>(() => {
  const prompt = projectPrompt.value;
  if (prompt === null) return [];
  const rows: ConfirmDialogRow[] = [
    {
      key: 'worktree',
      icon: 'git-fork',
      text:
        prompt.branch === undefined
          ? t('worktreeManage.existingProjectBodyNoBranch', { project: prompt.project })
          : t('worktreeManage.existingProjectBody', { project: prompt.project, branch: prompt.branch }),
    },
  ];
  if (prompt.sessionCount > 0) {
    rows.push({
      key: 'sessions',
      icon: 'alert-triangle',
      tone: 'warning',
      text: t('worktreeManage.existingProjectSessions', { n: prompt.sessionCount }),
    });
  }
  return rows;
});

function onPromptCancel(source: ConfirmDialogCancelSource): void {
  answerExistingWorktreeProject(source === 'button' ? 'create' : 'dismiss');
}
</script>

<template>
  <ManageDeleteDialog
    v-if="deleteDialog !== null"
    :state="deleteDialog"
    :progress="deleteProgress"
    @set-delete-branch="setDeleteBranch"
    @confirm="confirmDeletion"
    @retry="retryFailedDeletion"
    @close="closeDeleteDialog"
  />
  <ConfirmDialog
    v-if="projectPrompt !== null"
    :open="true"
    :title="t('worktreeManage.existingProjectTitle')"
    :rows="promptRows"
    :confirm-label="t('worktreeManage.existingProjectSwitch')"
    :cancel-label="t('worktreeManage.existingProjectCreate')"
    variant="primary"
    @confirm="answerExistingWorktreeProject('switch')"
    @cancel="onPromptCancel"
  />
</template>
