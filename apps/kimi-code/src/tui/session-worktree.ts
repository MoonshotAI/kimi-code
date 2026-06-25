import type { JsonObject, Session } from '@moonshot-ai/kimi-code-sdk';

/**
 * Worktree session-metadata helpers for the TUI.
 *
 * Kept out of the high-churn `kimi-tui.ts` so the worktree wiring stays a
 * one-line call site and future TUI edits are less likely to collide with the
 * worktree feature.
 */

/**
 * Recovers the worktree metadata carried by an existing session so a
 * replacement session (e.g. from `/new`) stays in the same worktree context.
 *
 * Resuming a worktree session via `-r <id>` carries no `--worktree` CLI flags,
 * so the startup metadata is undefined; without this the new session would lose
 * its `worktreePath` / `parentRepoPath` and agents/subagents would drop the
 * worktree system-prompt context. Mirrors the flat shape persisted at launch.
 */
export function worktreeMetadataFromSession(session: Session | undefined): JsonObject | undefined {
  const metadata = session?.summary?.metadata;
  if (metadata === undefined) {
    return undefined;
  }
  const worktreePath = metadata['worktreePath'];
  const parentRepoPath = metadata['parentRepoPath'];
  if (typeof worktreePath !== 'string' || typeof parentRepoPath !== 'string') {
    return undefined;
  }
  return { worktreePath, parentRepoPath };
}

/**
 * The session metadata a `/new` replacement should carry: the metadata supplied
 * at startup (set when launched with `--worktree`), falling back to whatever the
 * current session recorded so resumed worktree sessions are preserved.
 */
export function resolveSessionMetadata(
  startupMetadata: JsonObject | undefined,
  session: Session | undefined,
): JsonObject | undefined {
  return startupMetadata ?? worktreeMetadataFromSession(session);
}
