import { spawn } from 'node:child_process';

import {
  DEFAULT_REMOTE_BIN,
  assertLauncherOperand,
  dockerBaseArgs,
  type LauncherSpec,
} from './launchers';

export interface LocalRunRequest {
  readonly program: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export interface LocalRunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type LocalRunner = (request: LocalRunRequest) => Promise<LocalRunResult>;

const LOCAL_RUN_CAPTURE_LIMIT = 64 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 60_000;
const SIGKILL_GRACE_MS = 500;

export function defaultLocalRunner(request: LocalRunRequest): Promise<LocalRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.program, [...request.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = request.timeoutMs ?? STEP_TIMEOUT_MS;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      stderr = `${stderr}\ncommand timed out after ${String(timeoutMs)}ms`.slice(
        -LOCAL_RUN_CAPTURE_LIMIT,
      );
      child.kill('SIGTERM');
      // A launcher child that ignores SIGTERM (command-type launchers are
      // user-defined) must not hang the step forever: escalate to SIGKILL
      // after a short grace, mirroring ExecBridge.close().
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-LOCAL_RUN_CAPTURE_LIMIT);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-LOCAL_RUN_CAPTURE_LIMIT);
    });
    child.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export function launcherLabel(launcher: LauncherSpec): string {
  switch (launcher.type) {
    case 'ssh':
      return `ssh:${launcher.host}`;
    case 'docker':
      return `docker:${launcher.container}`;
    case 'command':
      return `command:${launcher.program}`;
  }
}

// docker exec passes argv to execve without a shell, so a tilde-prefixed
// remoteBin (the default included) would be invoked literally and fail with
// exit 126. Resolve the container user's $HOME with one shell probe and
// substitute the absolute path before the first exec attempt. Best-effort:
// when the probe fails (container down, no shell, empty/relative $HOME) the
// launcher is returned unchanged and the connect surfaces the underlying
// error instead. ssh launchers keep the tilde form — the remote shell
// expands it.
export async function resolveTildeRemoteBin(
  launcher: LauncherSpec,
  runner: LocalRunner,
): Promise<LauncherSpec> {
  if (launcher.type !== 'docker') return launcher;
  const remoteBin = launcher.remoteBin ?? DEFAULT_REMOTE_BIN;
  if (remoteBin !== '~' && !remoteBin.startsWith('~/')) return launcher;
  const homeDir = await probeDockerHomeDir(launcher, runner);
  if (homeDir === undefined) return launcher;
  return { ...launcher, remoteBin: `${homeDir === '/' ? '' : homeDir}${remoteBin.slice(1)}` };
}

async function probeDockerHomeDir(
  launcher: LauncherSpec & { readonly type: 'docker' },
  runner: LocalRunner,
): Promise<string | undefined> {
  assertLauncherOperand('docker container', launcher.container);
  let result: LocalRunResult;
  try {
    result = await runner({
      program: 'docker',
      args: [
        ...dockerBaseArgs(launcher.context),
        'exec',
        launcher.container,
        'sh',
        '-c',
        'printf "%s" "$HOME"',
      ],
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;
  const homeDir = result.stdout.trim();
  return homeDir.startsWith('/') ? homeDir : undefined;
}
