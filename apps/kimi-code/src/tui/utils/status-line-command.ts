import { spawn } from 'node:child_process';

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
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const isWin = process.platform === 'win32';
    let child;
    try {
      child = spawn(isWin ? (process.env['ComSpec'] ?? 'cmd.exe') : 'sh', isWin ? ['/d', '/s', '/c', command] : ['-c', command], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, KIMI_CODE_STATUS_LINE: '1' },
        detached: !isWin,
      });
    } catch {
      finish(null);
      return;
    }

    const killTree = (): void => {
      if (child.pid === undefined) return;
      if (isWin) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {}
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };

    const timer = setTimeout(() => {
      killTree();
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    let stdout = '';
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.includes('\n')) return;
      stdout += chunk;
      const cut = stdout.indexOf('\n');
      if (cut >= 0) {
        stdout = stdout.slice(0, cut + 1);
      } else if (stdout.length > STATUS_LINE_MAX_CAPTURE_BYTES) {
        stdout = stdout.slice(0, STATUS_LINE_MAX_CAPTURE_BYTES);
      }
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

    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
}

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
