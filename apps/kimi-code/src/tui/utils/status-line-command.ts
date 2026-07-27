/**
 * User-provided status line command (`status_line.command` in tui.toml).
 *
 * The footer spawns the command with a JSON snapshot on stdin and renders the
 * first stdout line. Runs are throttled and time-boxed; any failure (spawn
 * error, nonzero exit, timeout) yields null so the caller falls back to the
 * built-in layout. Mirrors Claude Code's statusLine contract at the seam:
 * JSON in, first line out, 300ms ceiling.
 */

import { spawn } from 'node:child_process';

export const STATUS_LINE_COMMAND_TIMEOUT_MS = 300;
export const STATUS_LINE_RERUN_INTERVAL_MS = 1_000;

export interface StatusLinePayload {
  model: string;
  cwd: string;
  gitBranch: string | null;
  permissionMode: string;
  planMode: boolean;
  contextUsage: number;
  contextTokens: number;
  maxContextTokens: number;
  sessionId: string;
  version: string;
}

export function runStatusLineCommand(
  command: string,
  payload: StatusLinePayload,
  timeoutMs: number = STATUS_LINE_COMMAND_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn('sh', ['-c', command], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, KIMI_CODE_STATUS_LINE: '1' },
      });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    let stdout = '';
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      const firstLine = (stdout.split('\n')[0] ?? '').trimEnd();
      finish(firstLine.length > 0 ? firstLine : null);
    });

    child.stdin?.on('error', () => {
      // The command closed stdin early (e.g. `true`); nothing more to send.
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}

/**
 * Throttled cache around `runStatusLineCommand` for a sync render path:
 * `current()` returns the last good line, and a refresh is kicked off in the
 * background at most once per interval. `onUpdate` fires when a fresh line
 * lands so the footer can repaint.
 */
export class StatusLineCommandRunner {
  private lastRunAt = 0;
  private cached: string | null = null;
  private inFlight = false;

  constructor(
    private readonly command: string,
    private readonly onUpdate: () => void,
  ) {}

  current(): string | null {
    return this.cached;
  }

  maybeRefresh(payload: StatusLinePayload): void {
    const now = Date.now();
    if (this.inFlight || now - this.lastRunAt < STATUS_LINE_RERUN_INTERVAL_MS) {
      return;
    }
    this.inFlight = true;
    this.lastRunAt = now;
    void runStatusLineCommand(this.command, payload).then((line) => {
      this.inFlight = false;
      if (line !== null) {
        this.cached = line;
        this.onUpdate();
      }
    });
  }
}
