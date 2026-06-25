import type { WorktreeInfo } from './types';

/**
 * Extracts git worktree metadata from a session's custom metadata bag.
 *
 * Populated when a session was launched with `--worktree`; the flat
 * `worktreePath` / `parentRepoPath` pair is persisted on the session so that
 * resumed sessions and spawned subagents keep the worktree system-prompt
 * context. Kept separate from prepared-prompt-context loading so changes to
 * AGENTS.md handling and worktree parsing do not collide.
 */
export function getWorktreeInfoFromSessionMetadata(metadata: {
  readonly custom: Record<string, unknown>;
}): WorktreeInfo | undefined {
  const custom = metadata.custom;
  const worktreePath = custom?.['worktreePath'];
  const parentRepoPath = custom?.['parentRepoPath'];
  if (typeof worktreePath === 'string' && typeof parentRepoPath === 'string') {
    return { worktreePath, parentRepoPath };
  }
  return undefined;
}
