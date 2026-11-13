/**
 * User-provided status line command (`status_line.command` in tui.toml).
 *
 * The footer spawns the command with a JSON snapshot on stdin and renders the
 * first stdout line. Runs are throttled and time-boxed; any failure (spawn
 * error, nonzero exit, timeout) yields null so the caller falls back to the
 * built-in layout. Mirrors Claude Code's statusLine contract at the seam:
 * JSON in, first line out, 300ms ceiling.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export const STATUS_LINE_COMMAND_TIMEOUT_MS = 300;
export const STATUS_LINE_RERUN_INTERVAL_MS = 1_000;
export const STATUS_LINE_MAX_CAPTURE_BYTES = 65_536;

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
  posixShell: string = '/bin/sh',
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const isWin = process.platform === 'win32';
    const payloadJson = JSON.stringify(payload);
    let activeChild: ChildProcess | undefined;

    const killTree = (): void => {
      if (activeChild?.pid === undefined) return;
      if (isWin) {
        try {
          spawn('taskkill', ['/pid', String(activeChild.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          // best effort
        }
      } else {
        try {
          process.kill(-activeChild.pid, 'SIGKILL');
        } catch {
          activeChild.kill('SIGKILL');
        }
      }
    };

    const timer = setTimeout(() => {
      killTree();
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    const launch = (posixExecutable: string, allowPathFallback: boolean): void => {
      if (settled) return;
      let child: ChildProcess;
      try {
        child = spawn(
          isWin ? (process.env['ComSpec'] ?? 'cmd.exe') : posixExecutable,
          isWin ? ['/d', '/s', '/c', command] : ['-c', command],
          {
            stdio: ['pipe', 'pipe', 'ignore'],
            env: { ...process.env, KIMI_CODE_STATUS_LINE: '1' },
            // Own process group on POSIX so a timeout can drop the whole tree,
            // not just the shell wrapper.
            detached: !isWin,
          },
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!isWin && allowPathFallback && (code === 'ENOENT' || code === 'ENOTDIR')) {
          launch('sh', false);
          return;
        }
        clearTimeout(timer);
        finish(null);
        return;
      }

      activeChild = child;
      let stdout = '';
      child.stdout?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        if (settled || child !== activeChild) return;
        if (stdout.includes('\n')) return; // first line is complete
        stdout += chunk;
        // Only the first line is ever used; stop accumulating past it (and cap
        // a missing-newline stream) so a chatty command can't grow memory
        // unboundedly before the timeout lands.
        const cut = stdout.indexOf('\n');
        if (cut >= 0) {
          stdout = stdout.slice(0, cut + 1);
        } else if (stdout.length > STATUS_LINE_MAX_CAPTURE_BYTES) {
          stdout = stdout.slice(0, STATUS_LINE_MAX_CAPTURE_BYTES);
        }
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (settled || child !== activeChild) return;
        if (!isWin && allowPathFallback && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
          launch('sh', false);
          return;
        }
        clearTimeout(timer);
        finish(null);
      });
      child.on('close', (code) => {
        if (settled || child !== activeChild) return;
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
      child.stdin?.end(payloadJson);
    };

    launch(posixShell, !isWin && posixShell !== 'sh');
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
  private pendingPayload: StatusLinePayload | null = null;
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly command: string,
    private readonly onUpdate: () => void,
  ) {}

  current(): string | null {
    return this.cached;
  }

  maybeRefresh(payload: StatusLinePayload): void {
    const now = Date.now();
    if (this.inFlight || now - this.lastRunAt < STATUS_LINE_RERUN_INTERVAL_MS) {
      // Don't drop the update: land it as soon as the current gap expires,
      // so a final state change is never lost to throttling.
      this.pendingPayload = payload;
      this.scheduleTrailing(now);
      return;
    }
    this.startRun(payload, now);
  }

  dispose(): void {
    if (this.trailingTimer !== null) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }
    this.pendingPayload = null;
  }

  private scheduleTrailing(now: number): void {
    if (this.trailingTimer !== null) return;
    const waitMs = Math.max(0, STATUS_LINE_RERUN_INTERVAL_MS - (now - this.lastRunAt));
    this.trailingTimer = setTimeout(() => {
      this.trailingTimer = null;
      const pending = this.pendingPayload;
      this.pendingPayload = null;
      if (pending !== null) this.maybeRefresh(pending);
    }, waitMs);
    this.trailingTimer.unref?.();
  }

  private startRun(payload: StatusLinePayload, now: number): void {
    this.inFlight = true;
    this.lastRunAt = now;
    void runStatusLineCommand(this.command, payload).then((line) => {
      this.inFlight = false;
      if (line !== null) {
        this.cached = line;
        this.onUpdate();
      }
      const pending = this.pendingPayload;
      this.pendingPayload = null;
      if (pending !== null) this.maybeRefresh(pending);
    });
  }
}
