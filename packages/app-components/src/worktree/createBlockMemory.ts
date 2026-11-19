import type { AppSessionWorktree } from '@moonshot-ai/app-core/api';

const MAX_REMEMBERED = 64;
const originals = new Map<string, AppSessionWorktree>();

export function rememberCreateRun(sessionId: string, worktree: AppSessionWorktree): void {
  if (worktree.setup.purpose !== 'create' || worktree.setup.status !== 'ready') return;
  originals.delete(sessionId);
  originals.set(sessionId, worktree);
  while (originals.size > MAX_REMEMBERED) originals.delete(originals.keys().next().value!);
}

export function recallCreateRun(sessionId: string): AppSessionWorktree | null {
  return originals.get(sessionId) ?? null;
}

export function forgetCreateRuns(): void {
  originals.clear();
}
