import type { AppWorktree, WorktreeRemoveFailureReason } from '@moonshot-ai/app-core/api';
import type { Translator } from '@moonshot-ai/app-core/contracts';
import type { WorktreeRemovalItem, WorktreeRemovalState } from '../stores/worktrees';

const MB = 1024 * 1024;
const GB = 1024 * MB;

export function formatWorktreeSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / MB)} MB`;
}

export interface WorktreeDeleteRisk {
  uncommittedFiles: number;
  unpushedCommits: number;
}

export interface WorktreeDeleteTarget {
  path: string;
  name: string;
  branch?: string;
  projectName: string;
  sessionCount: number;
  risk: WorktreeDeleteRisk | null;
}

export type WorktreeDeleteRowIcon = 'folder' | 'message' | 'alert-triangle' | 'circle-check';

export type WorktreeDeleteRowKind = 'target' | 'sessions' | 'risk' | 'safe' | 'unknown' | 'retained';

export interface WorktreeDeleteListItem {
  key: string;
  name: string;
  nameIsDirectory: boolean;
  meta?: string;
  loss?: string;
  state?: WorktreeRemovalState;
  stateText?: string;
}

export interface WorktreeDeleteRow {
  key: WorktreeDeleteRowKind;
  icon: WorktreeDeleteRowIcon;
  tone: 'muted' | 'warning';
  text: string;
  trailing?: string;
  items?: WorktreeDeleteListItem[];
}

interface EffectiveRisk {
  files: number;
  commits: number;
}

function effectiveRisk(risk: WorktreeDeleteRisk, deleteBranch: boolean): EffectiveRisk {
  return {
    files: Math.max(0, risk.uncommittedFiles),
    commits: deleteBranch ? Math.max(0, risk.unpushedCommits) : 0,
  };
}

function isRisky(risk: EffectiveRisk): boolean {
  return risk.files > 0 || risk.commits > 0;
}

function riskSentence(risk: EffectiveRisk, t: Translator): string {
  const files = t('worktreeManage.filesUncommitted', { n: risk.files });
  const commits = t('worktreeManage.commitsUnpushed', { n: risk.commits });
  if (risk.files > 0 && risk.commits > 0) return t('worktreeManage.riskBoth', { files, commits });
  return t('worktreeManage.riskOne', { what: risk.files > 0 ? files : commits });
}

function riskShort(risk: EffectiveRisk, t: Translator): string {
  const files = t('worktreeManage.shortUncommitted', { n: risk.files });
  const commits = t('worktreeManage.shortUnpushed', { n: risk.commits });
  if (risk.files > 0 && risk.commits > 0) return t('worktreeManage.shortJoin', { files, commits });
  if (risk.files > 0) return files;
  return risk.commits > 0 ? commits : '';
}

export function worktreeRiskRow(
  risk: WorktreeDeleteRisk | null,
  deleteBranch: boolean,
  t: Translator,
): WorktreeDeleteRow {
  if (risk === null) {
    return { key: 'unknown', icon: 'alert-triangle', tone: 'warning', text: t('worktreeManage.riskUnknown') };
  }
  const effective = effectiveRisk(risk, deleteBranch);
  if (isRisky(effective)) {
    return { key: 'risk', icon: 'alert-triangle', tone: 'warning', text: riskSentence(effective, t) };
  }
  return {
    key: 'safe',
    icon: 'circle-check',
    tone: 'muted',
    text: t(deleteBranch ? 'worktreeManage.noRiskWithBranch' : 'worktreeManage.noRisk'),
  };
}

export function worktreeTargetLabel(target: { name: string; branch?: string }): string {
  return target.branch ?? target.name;
}

export function worktreeTargetIsDirectory(target: { branch?: string }): boolean {
  return target.branch === undefined;
}

export function worktreeDeleteRows(
  targets: readonly WorktreeDeleteTarget[],
  deleteBranch: boolean,
  t: Translator,
): WorktreeDeleteRow[] {
  const rows: WorktreeDeleteRow[] = [];
  const batch = targets.length > 1;
  const first = targets[0];
  if (first === undefined) return rows;
  if (batch) {
    const risky = (target: WorktreeDeleteTarget): boolean =>
      target.risk !== null && isRisky(effectiveRisk(target.risk, deleteBranch));
    const ordered = targets.toSorted((a, b) => Number(risky(b)) - Number(risky(a)));
    rows.push({
      key: 'target',
      icon: 'folder',
      tone: 'muted',
      text: t(deleteBranch ? 'worktreeManage.targetListWithBranches' : 'worktreeManage.targetList'),
      trailing: t('worktreeManage.targetTotal', { n: targets.length }),
      items: ordered.map((target) => ({
        key: target.path,
        name: worktreeTargetLabel(target),
        nameIsDirectory: worktreeTargetIsDirectory(target),
        meta: target.projectName,
        loss:
          target.risk === null
            ? t('worktreeManage.shortUnknown')
            : riskShort(effectiveRisk(target.risk, deleteBranch), t),
      })),
    });
  } else {
    rows.push({
      key: 'target',
      icon: 'folder',
      tone: 'muted',
      text: t(deleteBranch ? 'worktreeManage.targetDirectoryAndBranch' : 'worktreeManage.targetDirectory', {
        branch: worktreeTargetLabel(first),
      }),
    });
  }
  const sessions = targets.reduce((sum, target) => sum + Math.max(0, target.sessionCount), 0);
  if (sessions > 0) {
    rows.push({
      key: 'sessions',
      icon: 'message',
      tone: 'muted',
      text: t(batch ? 'worktreeManage.sessionsAffectedBatch' : 'worktreeManage.sessionsAffected', { n: sessions }),
    });
  }
  if (!batch) {
    rows.push(worktreeRiskRow(first.risk, deleteBranch, t));
    return rows;
  }
  const riskyCount = targets.filter(
    (target) => target.risk !== null && isRisky(effectiveRisk(target.risk, deleteBranch)),
  ).length;
  const unknownCount = targets.filter((target) => target.risk === null).length;
  if (riskyCount > 0) {
    rows.push({
      key: 'risk',
      icon: 'alert-triangle',
      tone: 'warning',
      text: t('worktreeManage.riskBatch', { n: riskyCount }),
    });
  }
  if (unknownCount > 0) {
    rows.push({
      key: 'unknown',
      icon: 'alert-triangle',
      tone: 'warning',
      text: t('worktreeManage.riskUnknownBatch', { n: unknownCount }),
    });
  }
  if (riskyCount === 0 && unknownCount === 0) {
    rows.push({
      key: 'safe',
      icon: 'circle-check',
      tone: 'muted',
      text: t(deleteBranch ? 'worktreeManage.noRiskWithBranch' : 'worktreeManage.noRisk'),
    });
  }
  return rows;
}

export function worktreeSessionDeleteRows(
  input: { title: string; otherSessions: number; risk: WorktreeDeleteRisk | null; deleteBranch: boolean },
  t: Translator,
): WorktreeDeleteRow[] {
  if (input.otherSessions > 0) {
    return [
      {
        key: 'target',
        icon: 'message',
        tone: 'muted',
        text: t('worktreeManage.sessionTargetShared', { title: input.title }),
      },
      {
        key: 'retained',
        icon: 'folder',
        tone: 'muted',
        text: t('worktreeManage.sessionRetained', { n: input.otherSessions }),
      },
    ];
  }
  return [
    { key: 'target', icon: 'message', tone: 'muted', text: t('worktreeManage.sessionTarget', { title: input.title }) },
    worktreeRiskRow(input.risk, input.deleteBranch, t),
  ];
}

export type WorktreeManageLabel = 'archived' | 'deleted';

export type WorktreeManageRowStatus = 'idle' | 'deleting' | 'failed';

export interface WorktreeManageRow {
  path: string;
  title: string;
  titleIsDirectory: boolean;
  label: WorktreeManageLabel | null;
  branch?: string;
  sizeBytes?: number;
  sessionsInUse: number;
  noSession: boolean;
  openSessionId?: string;
  busy: boolean;
  status: WorktreeManageRowStatus;
  failureReason?: WorktreeRemoveFailureReason;
  output?: string;
  deletable: boolean;
}

export function worktreeManageRow(
  worktree: AppWorktree,
  removal?: WorktreeRemovalItem,
  deletedSessionTitle?: string,
): WorktreeManageRow {
  const primary = worktree.sessions.find((session) => !session.archived) ?? worktree.sessions[0];
  const sessionGone = primary === undefined && deletedSessionTitle !== undefined;
  const label: WorktreeManageLabel | null = sessionGone ? 'deleted' : primary?.archived === true ? 'archived' : null;
  const busy = worktree.sessions.some((session) => session.busy);
  const status: WorktreeManageRowStatus =
    removal?.state === 'waiting' || removal?.state === 'deleting'
      ? 'deleting'
      : removal?.state === 'failed'
        ? 'failed'
        : 'idle';
  const row: WorktreeManageRow = {
    path: worktree.path,
    title: primary?.title ?? deletedSessionTitle ?? worktree.name,
    titleIsDirectory: primary === undefined && deletedSessionTitle === undefined,
    label,
    sessionsInUse: worktree.sessions.length,
    noSession: primary === undefined && !sessionGone,
    busy,
    status,
    deletable: !busy && status !== 'deleting',
  };
  if (worktree.branch !== undefined) row.branch = worktree.branch;
  if (worktree.sizeBytes !== undefined) row.sizeBytes = worktree.sizeBytes;
  if (primary !== undefined && !primary.archived) row.openSessionId = primary.id;
  if (status === 'failed') {
    row.failureReason = removal?.reason ?? 'unknown';
    if (removal?.output !== undefined && removal.output !== '') row.output = removal.output;
  }
  return row;
}

export function worktreeFailureText(reason: WorktreeRemoveFailureReason | undefined, t: Translator): string {
  if (reason === 'in_use') return t('worktreeManage.failedInUse');
  if (reason === 'session_busy') return t('worktreeManage.failedSessionBusy');
  return t('worktreeManage.failedGeneric');
}

export interface WorktreeRemovalProgressItem {
  path: string;
  name: string;
  nameIsDirectory: boolean;
  state: WorktreeRemovalState;
  branchDeleted?: boolean;
}

export interface WorktreeRemovalProgress {
  items: WorktreeRemovalProgressItem[];
  total: number;
  completed: number;
  deleted: number;
  failed: number;
  running: boolean;
}

const PROGRESS_ORDER: Record<WorktreeRemovalState, number> = { failed: 0, deleting: 1, deleted: 2, waiting: 3 };

export function worktreeRemovalProgress(items: readonly WorktreeRemovalProgressItem[]): WorktreeRemovalProgress {
  const deleted = items.filter((item) => item.state === 'deleted').length;
  const failed = items.filter((item) => item.state === 'failed').length;
  return {
    items: items.toSorted((a, b) => PROGRESS_ORDER[a.state] - PROGRESS_ORDER[b.state]),
    total: items.length,
    completed: deleted + failed,
    deleted,
    failed,
    running: deleted + failed < items.length,
  };
}

export function worktreeRemovalStateText(state: WorktreeRemovalState, t: Translator): string {
  if (state === 'waiting') return t('worktreeManage.stateWaiting');
  if (state === 'deleting') return t('worktreeManage.stateDeleting');
  if (state === 'deleted') return t('worktreeManage.stateDeleted');
  return t('worktreeManage.stateFailed');
}

export function worktreeRemovalSummaryText(items: readonly WorktreeRemovalProgressItem[], t: Translator): string {
  const deleted = items.filter((item) => item.state === 'deleted');
  const failed = items.filter((item) => item.state === 'failed');
  if (failed.length > 0) {
    const only = items.length === 1 ? failed[0] : undefined;
    if (only !== undefined) return t('worktreeManage.summarySingleFailed', { name: only.name });
    const failedText = t('worktreeManage.failedCount', { n: failed.length });
    if (deleted.length === 0) return failedText;
    return t('worktreeManage.summaryJoin', {
      first: t('worktreeManage.deletedCount', { n: deleted.length }),
      second: failedText,
    });
  }
  const branches = deleted.filter((item) => item.branchDeleted === true).length;
  const single = deleted.length === 1 ? deleted[0] : undefined;
  if (single !== undefined) {
    return t(branches === 1 ? 'worktreeManage.toastDeletedWithBranch' : 'worktreeManage.toastDeleted', {
      name: single.name,
    });
  }
  if (branches === 0) return t('worktreeManage.toastDeletedBatch', { n: deleted.length });
  if (branches === deleted.length) return t('worktreeManage.toastDeletedBatchWithBranches', { n: deleted.length });
  return t('worktreeManage.summaryJoin', {
    first: t('worktreeManage.deletedCount', { n: deleted.length }),
    second: t('worktreeManage.branchesDeletedCount', { n: branches }),
  });
}
