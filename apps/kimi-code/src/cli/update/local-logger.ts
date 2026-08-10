/**
 * Minimal local stand-in for the SDK diagnostic logger (`log` / `Logger`,
 * re-exported by `@moonshot-ai/kimi-code-sdk` from the kimi-agent runtime).
 * The update preflight and the manual upgrade command only consume
 * `info`/`warn` on a shared singleton. Diagnostic logging is best-effort and
 * must never affect update prompting (a passive background update may run in
 * a session whose stderr is captured), so the local default is a no-op.
 */

export interface Logger {
  info(message: string, payload?: unknown): void;
  warn(message: string, payload?: unknown): void;
}

const noopLogger: Logger = {
  info() {
    // No-op: update diagnostics are best-effort only.
  },
  warn() {
    // No-op.
  },
};

/** Shared diagnostic logger singleton used when no logger is injected. */
export const log: Logger = noopLogger;
