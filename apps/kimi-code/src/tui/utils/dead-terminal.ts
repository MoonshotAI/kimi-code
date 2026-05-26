/**
 * Detects errors that mean the controlling terminal (stdout/stderr pty) is
 * effectively gone — for example after the parent shell crashed, the tmux
 * server vanished, or an SSH connection dropped without delivering SIGHUP.
 *
 * Continuing to write to a dead terminal would re-fire the same error on every
 * render tick and pin a CPU core. Callers should respond by skipping any
 * cleanup that touches stdout/stderr and exiting immediately.
 */
const DEAD_TERMINAL_ERROR_CODES = new Set<string>(['EIO', 'EPIPE', 'ENOTCONN']);

export function isDeadTerminalError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}
