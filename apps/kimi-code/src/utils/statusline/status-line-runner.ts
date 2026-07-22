/**
 * Periodic runner for the user-configured statusline command.
 *
 * Mirrors the footer-side conventions of `utils/git/git-status.ts`
 * (`setInterval` + `unref()`), while the child-process handling follows
 * `agent-core-v2`'s hook runner: `shell: true`, the session context JSON
 * is written to stdin, a timeout escalates SIGTERM → SIGKILL, and stdout
 * is capped so a runaway script cannot grow memory unboundedly.
 *
 * Only the first stdout line is kept. A failing run preserves the last
 * successful output; before the first success `getOutput()` is `null`
 * and the footer renders nothing.
 */

import { spawn } from 'node:child_process';

const MAX_STDOUT_BYTES = 64 * 1024;
const KILL_GRACE_MS = 100;

export interface StatusLineRunnerOptions {
  readonly command: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  /** Builds the stdin JSON payload; called fresh on every run. */
  readonly getInput: () => Record<string, unknown>;
  /** Called after a successful run changed (or set) the output. */
  readonly onChange?: () => void;
}

export class StatusLineRunner {
  private readonly options: StatusLineRunnerOptions;
  private output: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private generation = 0;

  constructor(options: StatusLineRunnerOptions) {
    this.options = options;
  }

  /** Runs once immediately, then on every `intervalMs` tick. */
  start(): void {
    if (this.timer !== null) return;
    const generation = this.generation;
    void this.runOnce(generation);
    this.timer = setInterval(() => {
      void this.runOnce(generation);
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.generation += 1;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Last successful first-line output; `null` until the first success. */
  getOutput(): string | null {
    return this.output;
  }

  /**
   * Single execution, also exposed for tests. Skipped while a previous
   * run is still in flight (a slow script must not stack up processes).
   */
  async runOnce(generation: number = this.generation): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const firstLine = await executeStatusLineCommand(
        this.options.command,
        JSON.stringify(this.options.getInput()),
        this.options.timeoutMs,
      );
      if (firstLine === null || generation !== this.generation) return;
      const changed = this.output !== firstLine;
      this.output = firstLine;
      if (changed) this.options.onChange?.();
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * Runs `command` via the shell with `inputJson` on stdin. Resolves to the
 * first stdout line on exit code 0 (possibly the empty string), or `null`
 * on spawn error, non-zero exit, or timeout.
 */
function executeStatusLineCommand(
  command: string,
  inputJson: string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, {
        shell: true,
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    // `stdio: 'pipe'` guarantees all three streams exist.
    const childStdout = proc.stdout!;
    const childStderr = proc.stderr!;
    const childStdin = proc.stdin!;

    let stdout = '';
    let settled = false;

    const settle = (result: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // oxlint-disable-next-line promise/no-multiple-resolved -- `settled` guards the single resolve; the rule cannot see it
      resolve(result);
    };

    childStdout.setEncoding('utf8');
    childStdout.on('data', (chunk: string) => {
      // Keep consuming (so the child never blocks on a full pipe) but
      // stop retaining past the cap.
      if (stdout.length < MAX_STDOUT_BYTES) {
        stdout = (stdout + chunk).slice(0, MAX_STDOUT_BYTES);
      }
    });
    childStderr.resume();

    proc.on('error', () => {
      settle(null);
    });
    proc.on('close', (code) => {
      settle(code === 0 ? firstLineOf(stdout) : null);
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, KILL_GRACE_MS);
      killTimer.unref();
      settle(null);
    }, timeoutMs);
    timeout.unref?.();

    childStdin.on('error', () => {});
    childStdin.end(inputJson);
  });
}

function firstLineOf(stdout: string): string {
  const end = stdout.indexOf('\n');
  const line = end === -1 ? stdout : stdout.slice(0, end);
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
