import { computed, ref, watch } from 'vue';

import { WORKTREE_NOT_FOUND_CODE, type WorktreeInspection } from '@moonshot-ai/app-core/api';
import { t } from '../client/deps';
import { toast } from '../client/toast';
import {
  worktreeRemovalProgress,
  worktreeRemovalSummaryText,
  worktreeTargetIsDirectory,
  worktreeTargetLabel,
  type WorktreeDeleteRisk,
  type WorktreeDeleteTarget,
  type WorktreeRemovalProgress,
  type WorktreeRemovalProgressItem,
} from '../lib/worktreeManage';
import { worktreesStore } from '../stores/worktrees';
import { registerConfirmSurface } from './useConfirmDialog';
import {
  WORKTREE_RESULT_TOAST_MS,
  answerExistingWorktreeProject,
  askExistingWorktreeProject,
  worktreeProjectPrompt as projectPrompt,
} from './worktreeProjectPrompt';

export {
  WORKTREE_RESULT_TOAST_MS,
  type WorktreeProjectPromptChoice,
  type WorktreeProjectPromptState,
} from './worktreeProjectPrompt';

export interface WorktreeDeleteConfirmState {
  kind: 'worktrees';
  phase: 'confirm';
  targets: WorktreeDeleteTarget[];
  deleteBranch: boolean;
}

export interface WorktreeDeleteProgressState {
  kind: 'worktrees';
  phase: 'progress' | 'result';
  batchId: number;
}

export interface WorktreeSessionDeleteState {
  kind: 'session';
  sessionId: string;
  title: string;
  branch?: string;
  otherSessions: number;
  risk: WorktreeDeleteRisk | null;
  deleteBranch: boolean;
  busy: boolean;
}

export type WorktreeDeleteDialogState =
  | WorktreeDeleteConfirmState
  | WorktreeDeleteProgressState
  | WorktreeSessionDeleteState;

export interface WorktreeSessionDeleteRequest {
  sessionId: string;
  title: string;
  path: string;
  branch?: string;
}

export type WorktreeSessionDeleteResult<T> =
  | { confirmed: false; directoryMissing?: true }
  | { confirmed: true; value: T };

interface RemovalBatch {
  id: number;
  items: WorktreeRemovalProgressItem[];
  settled: boolean;
}

const deleteDialog = ref<WorktreeDeleteDialogState | null>(null);
const deleteRequestPending = ref(false);
const batches = ref<RemovalBatch[]>([]);

let requestSeq = 0;
let batchSeq = 0;
let watching = false;
let sessionRun: ((deleteBranch: boolean) => Promise<void>) | null = null;
let sessionCancel: (() => void) | null = null;
let settingsOpener: (() => void) | null = null;

registerConfirmSurface(() => deleteDialog.value !== null || projectPrompt.value !== null);

export function registerWorktreeSettingsOpener(opener: () => void): void {
  settingsOpener = opener;
}

export function openWorktreeSettings(): void {
  settingsOpener?.();
}

function riskFrom(inspection: WorktreeInspection | null, path: string): WorktreeDeleteRisk | null {
  const risk = inspection?.items.find((item) => item.path === path);
  if (risk === undefined) return null;
  return { uncommittedFiles: risk.uncommittedFiles, unpushedCommits: risk.unpushedCommits };
}

function isGone(inspection: WorktreeInspection | null, path: string): boolean {
  return inspection?.errors[path]?.code === WORKTREE_NOT_FOUND_CODE;
}

export function toastWithManage(title: string, options: { manage?: boolean; replace?: boolean } = {}): void {
  toast({
    layout: 'bar',
    ...(options.replace === false ? {} : { mode: 'replace' as const }),
    title,
    duration: WORKTREE_RESULT_TOAST_MS,
    ...(options.manage === false
      ? {}
      : {
          actions: [
            {
              label: t('worktreeManage.manage'),
              onClick: ({ dismiss }) => {
                dismiss();
                openWorktreeSettings();
              },
            },
          ],
        }),
  });
}

function showResultToast(items: readonly WorktreeRemovalProgressItem[], failed: boolean): void {
  toastWithManage(worktreeRemovalSummaryText(items, t), { manage: failed });
}

function dropBatch(id: number): void {
  batches.value = batches.value.filter((batch) => batch.id !== id);
}

function shownBatchId(): number | null {
  const state = deleteDialog.value;
  return state !== null && state.kind === 'worktrees' && state.phase !== 'confirm' ? state.batchId : null;
}

function settleBatch(batch: RemovalBatch): void {
  batch.settled = true;
  const paths = batch.items.map((item) => item.path);
  const failed = batch.items.some((item) => item.state === 'failed');
  const shown = shownBatchId() === batch.id;
  worktreesStore().dismissRemovals(paths, ['deleted']);
  if (failed && shown) {
    deleteDialog.value = { kind: 'worktrees', phase: 'result', batchId: batch.id };
    return;
  }
  if (shown) deleteDialog.value = null;
  showResultToast(batch.items, failed);
  dropBatch(batch.id);
}

function syncBatches(): void {
  const store = worktreesStore();
  for (const batch of batches.value) {
    if (batch.settled) continue;
    batch.items = batch.items.map((item) => {
      const removal = store.removalFor(item.path);
      if (removal === undefined) return item;
      return { ...item, state: removal.state, branchDeleted: removal.branchDeleted };
    });
    if (batch.items.every((item) => item.state === 'deleted' || item.state === 'failed')) settleBatch(batch);
  }
}

function ensureWatching(): void {
  if (watching) return;
  watching = true;
  watch(() => worktreesStore().removals, syncBatches, { flush: 'sync' });
}

function startBatch(items: WorktreeRemovalProgressItem[]): number {
  ensureWatching();
  const id = ++batchSeq;
  batches.value = [...batches.value, { id, items, settled: false }];
  deleteDialog.value = { kind: 'worktrees', phase: 'progress', batchId: id };
  return id;
}

async function requestWorktreeDeletion(paths: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  const seq = ++requestSeq;
  const store = worktreesStore();
  deleteRequestPending.value = true;
  let inspection: WorktreeInspection | null;
  try {
    inspection = await store.inspect(paths);
  } finally {
    if (seq === requestSeq) deleteRequestPending.value = false;
  }
  if (seq !== requestSeq) return false;
  const targets: WorktreeDeleteTarget[] = [];
  let gone = false;
  for (const path of paths) {
    const worktree = store.items.find((item) => item.path === path);
    if (worktree === undefined) continue;
    if (isGone(inspection, path)) {
      gone = true;
      continue;
    }
    const fresh = inspection?.items.find((item) => item.path === path);
    const target: WorktreeDeleteTarget = {
      path,
      name: worktree.name,
      projectName: store.groups.find((group) => group.items.some((item) => item.path === path))?.name ?? '',
      sessionCount: (fresh?.sessions ?? worktree.sessions).length,
      risk: riskFrom(inspection, path),
    };
    const branch = fresh?.branch ?? worktree.branch;
    if (branch !== undefined) target.branch = branch;
    targets.push(target);
  }
  if (gone) void store.load();
  if (targets.length === 0) return false;
  deleteDialog.value = { kind: 'worktrees', phase: 'confirm', targets, deleteBranch: false };
  return true;
}

function setDeleteBranch(value: boolean): void {
  const state = deleteDialog.value;
  if (state === null) return;
  if (state.kind === 'worktrees' && state.phase === 'confirm') deleteDialog.value = { ...state, deleteBranch: value };
  else if (state.kind === 'session' && !state.busy) deleteDialog.value = { ...state, deleteBranch: value };
}

function confirmDeletion(): void {
  const state = deleteDialog.value;
  if (state === null) return;
  if (state.kind === 'session') {
    if (state.busy || sessionRun === null) return;
    deleteDialog.value = { ...state, busy: true };
    void sessionRun(state.deleteBranch && state.branch !== undefined && state.otherSessions === 0);
    return;
  }
  if (state.phase !== 'confirm') return;
  startBatch(
    state.targets.map((target) => ({
      path: target.path,
      name: worktreeTargetLabel(target),
      nameIsDirectory: worktreeTargetIsDirectory(target),
      state: 'waiting',
    })),
  );
  worktreesStore().enqueueRemovals(
    state.targets.map((target) => ({
      path: target.path,
      deleteBranch: state.deleteBranch && target.branch !== undefined,
    })),
  );
}

function retryFailedDeletion(): void {
  const state = deleteDialog.value;
  if (state === null || state.kind !== 'worktrees' || state.phase !== 'result') return;
  const batch = batches.value.find((entry) => entry.id === state.batchId);
  const failed = batch?.items.filter((item) => item.state === 'failed') ?? [];
  dropBatch(state.batchId);
  if (failed.length === 0) {
    deleteDialog.value = null;
    return;
  }
  startBatch(failed.map((item) => ({ path: item.path, name: item.name, nameIsDirectory: item.nameIsDirectory, state: 'waiting' })));
  worktreesStore().retryFailedRemovals(failed.map((item) => item.path));
}

function closeDeleteDialog(): void {
  const state = deleteDialog.value;
  if (state === null) return;
  if (state.kind === 'session') {
    if (state.busy) return;
    deleteDialog.value = null;
    sessionCancel?.();
    return;
  }
  if (state.phase === 'result') dropBatch(state.batchId);
  deleteDialog.value = null;
}

async function requestSessionDeletion<T>(
  request: WorktreeSessionDeleteRequest,
  run: (options: { deleteBranch: boolean }) => Promise<T>,
): Promise<WorktreeSessionDeleteResult<T>> {
  const seq = ++requestSeq;
  const store = worktreesStore();
  const inspection = await store.inspect([request.path]);
  if (seq !== requestSeq) return { confirmed: false };
  if (isGone(inspection, request.path)) return { confirmed: false, directoryMissing: true };
  sessionCancel?.();
  const fresh = inspection?.items.find((item) => item.path === request.path);
  const sessions = fresh?.sessions ?? store.items.find((item) => item.path === request.path)?.sessions ?? [];
  const branch = request.branch ?? fresh?.branch;
  return new Promise<WorktreeSessionDeleteResult<T>>((resolve, reject) => {
    const finish = (): void => {
      sessionRun = null;
      sessionCancel = null;
    };
    sessionCancel = () => {
      finish();
      resolve({ confirmed: false });
    };
    sessionRun = async (deleteBranch) => {
      try {
        const value = await run({ deleteBranch });
        finish();
        deleteDialog.value = null;
        resolve({ confirmed: true, value });
      } catch (error) {
        finish();
        deleteDialog.value = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const state: WorktreeSessionDeleteState = {
      kind: 'session',
      sessionId: request.sessionId,
      title: request.title,
      otherSessions: sessions.filter((session) => session.id !== request.sessionId).length,
      risk: riskFrom(inspection, request.path),
      deleteBranch: false,
      busy: false,
    };
    if (branch !== undefined) state.branch = branch;
    deleteDialog.value = state;
  });
}

const deleteProgress = computed<WorktreeRemovalProgress | null>(() => {
  const state = deleteDialog.value;
  if (state === null || state.kind !== 'worktrees' || state.phase === 'confirm') return null;
  const batch = batches.value.find((entry) => entry.id === state.batchId);
  return batch === undefined ? null : worktreeRemovalProgress(batch.items);
});

export function resetWorktreeManageDialogs(): void {
  requestSeq += 1;
  sessionCancel?.();
  answerExistingWorktreeProject('dismiss');
  deleteDialog.value = null;
  deleteRequestPending.value = false;
  batches.value = [];
}

export function useWorktreeManageDialogs() {
  return {
    deleteDialog,
    deleteProgress,
    deleteRequestPending,
    projectPrompt,
    requestWorktreeDeletion,
    requestSessionDeletion,
    setDeleteBranch,
    confirmDeletion,
    retryFailedDeletion,
    closeDeleteDialog,
    askExistingWorktreeProject,
    answerExistingWorktreeProject,
  };
}
