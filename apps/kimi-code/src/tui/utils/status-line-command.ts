import { spawn } from 'node:child_process';
import { once } from 'node:events';

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
}

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
    shell: true,
    stdio: ['pipe', 'pipe', 'ignore'],
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
    child.kill();
    return null;
  }
  if (result.kind === 'error' || result.code !== 0) {
    return null;
  }

  const line = stdout.trimEnd().split(/\r?\n/, 1)[0]?.trimEnd() ?? '';
  return line.length > 0 ? line : null;
}
