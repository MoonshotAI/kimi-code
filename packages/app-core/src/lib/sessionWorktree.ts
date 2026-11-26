import type {
  AppGitBranch,
  AppSession,
  AppSessionWorktree,
  AppWorktree,
  AppWorktreeSetupRequest,
  WorkspaceGitBranches,
} from '../api/types';
import { basename } from './pathBasename';

type SessionWorktreeSource = Pick<AppSession, 'worktree'> | null | undefined;

export type SessionEnvironmentKind = 'local' | 'worktree' | 'settingUp' | 'invalid';

export function isWorktreeSession(session: SessionWorktreeSource): boolean {
  const worktree = session?.worktree;
  return worktree !== undefined && worktree.path !== undefined && worktree.setup.status !== 'local';
}

export function isSessionWorktreeSettingUp(session: SessionWorktreeSource): boolean {
  return session?.worktree?.setup.status === 'running';
}

export function isSessionWorktreeInvalid(session: SessionWorktreeSource): boolean {
  const worktree = session?.worktree;
  return worktree !== undefined && worktree.setup.status !== 'local' && worktree.missing === true;
}

export function classifySessionEnvironment(session: SessionWorktreeSource): SessionEnvironmentKind {
  if (isSessionWorktreeSettingUp(session)) return 'settingUp';
  if (isSessionWorktreeInvalid(session)) return 'invalid';
  if (isWorktreeSession(session)) return 'worktree';
  return 'local';
}

export function sessionEnvironmentTag(session: SessionWorktreeSource): Exclude<SessionEnvironmentKind, 'local'> | undefined {
  const kind = classifySessionEnvironment(session);
  return kind === 'local' ? undefined : kind;
}

export function sessionWorktreeHoldsPrompts(session: SessionWorktreeSource): boolean {
  const status = session?.worktree?.setup.status;
  return status !== undefined && status !== 'ready' && status !== 'local';
}

export function sessionWorktreeBlocksSend(session: SessionWorktreeSource): boolean {
  return isSessionWorktreeInvalid(session) && !sessionWorktreeHoldsPrompts(session);
}

export type SessionWorktreeCard =
  | 'fetchFailed'
  | 'fetchTimeout'
  | 'conflict'
  | 'diskFull'
  | 'createFailed'
  | 'stopped'
  | 'missing'
  | 'missingBranchGone';

const FAILURE_CARDS: Record<NonNullable<AppSessionWorktree['setup']['failure']>['kind'], SessionWorktreeCard> = {
  fetch_failed: 'fetchFailed',
  fetch_timeout: 'fetchTimeout',
  conflict: 'conflict',
  disk_full: 'diskFull',
  create_failed: 'createFailed',
};

export function sessionWorktreeCard(worktree: AppSessionWorktree | null | undefined): SessionWorktreeCard | null {
  if (worktree === null || worktree === undefined) return null;
  const setup = worktree.setup;
  switch (setup.status) {
    case 'running':
    case 'local':
      return null;
    case 'failed':
      return setup.failure === undefined ? 'createFailed' : FAILURE_CARDS[setup.failure.kind];
    case 'stopped':
      return 'stopped';
    case 'ready':
      if (worktree.missing !== true) return null;
      return worktree.branchMissing === true ? 'missingBranchGone' : 'missing';
    default:
      return null;
  }
}

export function sessionWorkingDirectory(session: Pick<AppSession, 'cwd' | 'worktree'>): string {
  return isWorktreeSession(session) ? (session.worktree?.path ?? session.cwd) : session.cwd;
}

export type NewSessionEnvironment = 'local' | 'worktree';

export type WorktreeAvailability = 'available' | 'loading' | 'disabled' | 'notGitRepo' | 'remoteHost' | 'failed';

export interface WorktreeSourcePreference {
  branch: string;
  includeLocalChanges?: boolean;
}

export interface WorktreeSourceSelection {
  branch: AppGitBranch;
  includeLocalChanges: boolean;
  isDefault: boolean;
}

export function defaultWorktreeSourceBranch(info: WorkspaceGitBranches): AppGitBranch | null {
  const head = info.headBranch === undefined ? undefined : info.branches.find((branch) => branch.name === info.headBranch);
  return head ?? info.branches[0] ?? null;
}

export function canIncludeLocalChanges(info: WorkspaceGitBranches, branch: string): boolean {
  return info.dirty && info.headBranch !== undefined && info.headBranch === branch;
}

export function resolveWorktreeSource(
  info: WorkspaceGitBranches | null | undefined,
  remembered?: WorktreeSourcePreference | null,
): WorktreeSourceSelection | null {
  if (info === null || info === undefined || !info.isRepo) return null;
  const rememberedBranch =
    remembered === null || remembered === undefined
      ? undefined
      : info.branches.find((branch) => branch.name === remembered.branch);
  if (rememberedBranch !== undefined) {
    return {
      branch: rememberedBranch,
      includeLocalChanges: remembered?.includeLocalChanges === true && canIncludeLocalChanges(info, rememberedBranch.name),
      isDefault: false,
    };
  }
  const fallback = defaultWorktreeSourceBranch(info);
  return fallback === null ? null : { branch: fallback, includeLocalChanges: false, isDefault: true };
}

export function buildWorktreeSetupRequest(
  selection: WorktreeSourceSelection,
  options?: { useRemote?: boolean },
): AppWorktreeSetupRequest {
  const request: AppWorktreeSetupRequest = { sourceBranch: selection.branch.name };
  if (selection.includeLocalChanges) request.includeLocalChanges = true;
  if (options?.useRemote === true && selection.branch.remoteRef !== undefined) request.useRemote = true;
  return request;
}

export function effectiveNewSessionEnvironment(
  preferred: NewSessionEnvironment,
  availability: WorktreeAvailability,
): NewSessionEnvironment {
  return preferred === 'worktree' && availability === 'available' ? 'worktree' : 'local';
}

export interface WorktreeProjectGroup {
  key: string;
  workspaceId?: string;
  repoRoot: string;
  name: string;
  items: AppWorktree[];
  sizeBytes?: number;
}

export function groupWorktreesByProject(items: readonly AppWorktree[]): WorktreeProjectGroup[] {
  const groups = new Map<string, WorktreeProjectGroup>();
  for (const item of items) {
    const key = item.workspaceId ?? item.repoRoot;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        workspaceId: item.workspaceId,
        repoRoot: item.repoRoot,
        name: item.workspaceName ?? basename(item.repoRoot),
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(item);
    if (item.sizeBytes !== undefined) group.sizeBytes = (group.sizeBytes ?? 0) + item.sizeBytes;
  }
  return [...groups.values()];
}
