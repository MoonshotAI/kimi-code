import { quoteShellArg } from '#/utils/shell-quote';

/**
 * Formats the `kimi -r <id>` command shown to resume a session.
 *
 * When the session ran in a worktree, the command is prefixed with a `cd` into
 * that directory so resuming lands in the same checkout. Centralized here so
 * the prompt and shell runners format resume output identically and future
 * resume-output work touches one place.
 */
export function formatResumeCommand(
  sessionId: string,
  options: { readonly cwd?: string } = {},
): string {
  const { cwd } = options;
  return cwd !== undefined
    ? `cd ${quoteShellArg(cwd)} && kimi -r ${sessionId}`
    : `kimi -r ${sessionId}`;
}
