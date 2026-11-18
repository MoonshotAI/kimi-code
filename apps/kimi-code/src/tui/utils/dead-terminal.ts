const DEAD_TERMINAL_ERROR_CODES = new Set<string>(['EIO', 'EPIPE', 'ENOTCONN']);

export function isDeadTerminalError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}
