import { spawn } from 'node:child_process';
import { once } from 'node:events';

import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

const PROCESS_KILL_GRACE_MS = 100;

export interface StatusLineCommandPayload {
  readonly session_id: string;
  readonly model: string;
  readonly display_model: string;
  readonly cwd: string;
  readonly permission_mode: string;
  readonly plan_mode: boolean;
  readonly input_mode: string;
  readonly swarm_mode: boolean;
  readonly thinking_effort: string;
  readonly context: {
    readonly usage: number;
    readonly tokens: number;
    readonly max_tokens: number;
  };
  readonly rate_limits: readonly StatusLineRateLimit[];
}

export interface StatusLineRateLimit {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly reset_hint?: string;
}

export type StatusLineManagedUsage = Awaited<
  ReturnType<KimiHarness['auth']['getManagedUsage']>
>;

export type StatusLineManagedUsageLoader = (
  providerKey: string,
) => Promise<StatusLineManagedUsage | undefined>;

export interface RunStatusLineCommandOptions {
  readonly command: string;
  readonly timeoutMs: number;
  readonly payload: StatusLineCommandPayload;
}

export async function runStatusLineCommand({
  command,
  timeoutMs,
  payload,
}: RunStatusLineCommandOptions): Promise<string | null> {
  const child = spawn(command, {
    detached: process.platform !== 'win32',
    shell: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });

  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });

  child.stdin.on('error', () => {});
  child.stdin.end(`${JSON.stringify(payload)}\n`);

  const timeout = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
    timer.unref?.();
  });
  const closed = once(child, 'close').then(([code]) => ({
    kind: 'close' as const,
    code: typeof code === 'number' ? code : null,
  }));
  const errored = once(child, 'error').then(() => ({ kind: 'error' as const }));
  const result = await Promise.race([closed, errored, timeout]);

  if (result === 'timeout') {
    killProcessTree(child);
    return null;
  }
  if (result.kind === 'error' || result.code !== 0) {
    return null;
  }

  const line = stdout.trimEnd().split(/\r?\n/, 1)[0]?.trimEnd() ?? '';
  return line.length > 0 ? line : null;
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  tryKillProcessTree(child, 'SIGTERM');
  const timer = setTimeout(() => {
    tryKillProcessTree(child, 'SIGKILL');
  }, PROCESS_KILL_GRACE_MS);
  timer.unref?.();
}

function tryKillProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (process.platform === 'win32') {
    if (child.pid === undefined) return;
    const args =
      signal === 'SIGKILL'
        ? ['/T', '/F', '/PID', String(child.pid)]
        : ['/T', '/PID', String(child.pid)];
    try {
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => {});
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
    return;
  }

  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}
