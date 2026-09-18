import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname as posixDirname } from 'node:path/posix';

import { compareVersions, MIN_EXECUTOR_VERSION } from '#/protocol/methods';

import {
  downloadExecutorArtifact,
  releaseTargetKey,
  type DownloadedExecutorArtifact,
  type ExecutorArtifact,
  type ExecutorArtifactLocator,
  type ExecutorArtifactTarget,
} from './artifactLocator';
import {
  DEFAULT_REMOTE_BIN,
  dockerBaseArgs,
  SSH_CONFIG_OPTIONS,
  sshBaseArgs,
  type LauncherSpec,
} from './launchers';

export type ExecutorInstallStep =
  | 'probe'
  | 'locate'
  | 'download'
  | 'prepare'
  | 'upload'
  | 'activate'
  | 'post-check';

export class ExecutorInstallError extends Error {
  readonly step: ExecutorInstallStep;
  readonly artifact?: ExecutorArtifact;

  constructor(
    step: ExecutorInstallStep,
    message: string,
    options: { cause?: unknown; artifact?: ExecutorArtifact } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ExecutorInstallError';
    this.step = step;
    this.artifact = options.artifact;
  }
}

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
const UPLOAD_TIMEOUT_MS = 600_000;
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

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface RemoteBinPlan {
  // Path the launcher should invoke after the install. ssh keeps the tilde
  // form (the remote shell expands it); docker needs the absolute home-based
  // path (docker exec takes argv without a shell).
  readonly invokePath: string;
  // Verbatim absolute paths on the target. They are used unquoted in the scp
  // target (OpenSSH ≥ 9.0 scp speaks SFTP — no remote shell, no expansion) and
  // sh-quoted at the remote-command use sites.
  readonly binDir: string;
  readonly dest: string;
  readonly tmp: string;
}

function remoteBinPlan(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  homeDir: string | undefined,
): RemoteBinPlan {
  const uuid = randomUUID();
  const remoteBin = launcher.remoteBin;
  const isDefault = remoteBin === undefined || remoteBin === DEFAULT_REMOTE_BIN;
  if (isDefault) {
    if (homeDir === undefined || homeDir.length === 0) {
      throw new ExecutorInstallError(
        'probe',
        `could not determine the remote home directory on ${launcherLabel(launcher)}; ` +
          'set remoteBin to an absolute path in the environment declaration to skip the probe',
      );
    }
    const dir = `${homeDir}/.kimi-code/bin`;
    return {
      invokePath: launcher.type === 'ssh' ? DEFAULT_REMOTE_BIN : `${dir}/kimi`,
      binDir: dir,
      dest: `${dir}/kimi`,
      tmp: `${dir}/.kimi-install-${uuid}`,
    };
  }
  const dir = posixDirname(remoteBin);
  return {
    invokePath: remoteBin,
    binDir: dir,
    dest: remoteBin,
    tmp: `${dir}/.kimi-install-${uuid}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeRequest(request: LocalRunRequest): string {
  return [request.program, ...request.args].join(' ');
}

async function runStep(
  step: ExecutorInstallStep,
  runner: LocalRunner,
  request: LocalRunRequest,
  what: string,
  artifact?: ExecutorArtifact,
): Promise<LocalRunResult> {
  let result: LocalRunResult;
  try {
    result = await runner(request);
  } catch (error) {
    throw new ExecutorInstallError(
      step,
      `${what}: failed to run ${request.program}: ${errorMessage(error)} (argv: ${describeRequest(request)})`,
      { cause: error, artifact },
    );
  }
  if (result.code !== 0) {
    const output = result.stderr.trim() || result.stdout.trim() || 'no output';
    throw new ExecutorInstallError(
      step,
      `${what}: ${request.program} exited with code ${result.code ?? 'null'}` +
        `${result.signal !== null ? ` (signal ${result.signal})` : ''}: ${output} ` +
        `(argv: ${describeRequest(request)})`,
      { artifact },
    );
  }
  return result;
}

function parseUname(output: string): ExecutorArtifactTarget | undefined {
  const line = output.trim().split('\n')[0]?.trim() ?? '';
  const [kernel, machine] = line.split(/\s+/);
  const osKind = kernel === 'Linux' ? 'Linux' : kernel === 'Darwin' ? 'macOS' : undefined;
  const osArch =
    machine === 'x86_64' ? 'x64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : undefined;
  if (osKind === undefined || osArch === undefined) return undefined;
  return { osKind, osArch };
}

function parseVersionOutput(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

interface ProbedEnvironment {
  readonly target: ExecutorArtifactTarget;
  readonly homeDir?: string;
}

async function probeRemoteEnvironment(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  runner: LocalRunner,
): Promise<ProbedEnvironment> {
  const label = launcherLabel(launcher);
  const unameAndHome = 'uname -sm; printf "%s\\n" "$HOME"';
  const request: LocalRunRequest =
    launcher.type === 'ssh'
      ? {
          program: 'ssh',
          args: [...sshBaseArgs(), launcher.host, unameAndHome],
          timeoutMs: PROBE_TIMEOUT_MS,
        }
      : {
          program: 'docker',
          args: [
            ...dockerBaseArgs(launcher.context),
            'exec',
            launcher.container,
            'sh',
            '-c',
            unameAndHome,
          ],
          timeoutMs: PROBE_TIMEOUT_MS,
        };
  const result = await runStep(
    'probe',
    runner,
    request,
    `probing the target environment on ${label}`,
  );
  const target = parseUname(result.stdout);
  if (target === undefined) {
    throw new ExecutorInstallError(
      'probe',
      `probing the target environment on ${label}: unsupported or unrecognized target platform ` +
        `(uname output ${JSON.stringify(result.stdout.trim())})`,
    );
  }
  const lines = result.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const homeDir = lines.length > 1 ? lines.at(-1) : undefined;
  return { target, homeDir };
}

async function probeInstalledVersion(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  plan: RemoteBinPlan,
  runner: LocalRunner,
): Promise<string | undefined> {
  const request: LocalRunRequest =
    launcher.type === 'ssh'
      ? {
          program: 'ssh',
          args: [...sshBaseArgs(), launcher.host, `${shQuote(plan.dest)} --version`],
          timeoutMs: PROBE_TIMEOUT_MS,
        }
      : {
          program: 'docker',
          args: [...dockerBaseArgs(launcher.context), 'exec', launcher.container, plan.dest, '--version'],
          timeoutMs: PROBE_TIMEOUT_MS,
        };
  let result: LocalRunResult;
  try {
    result = await runner(request);
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;
  return parseVersionOutput(result.stdout);
}

async function prepareRemote(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  plan: RemoteBinPlan,
  runner: LocalRunner,
): Promise<void> {
  const what = `creating the executor directory on ${launcherLabel(launcher)}`;
  if (launcher.type === 'ssh') {
    await runStep(
      'prepare',
      runner,
      {
        program: 'ssh',
        args: [...sshBaseArgs(), launcher.host, `mkdir -p ${shQuote(plan.binDir)}`],
      },
      what,
    );
    return;
  }
  await runStep(
    'prepare',
    runner,
    {
      program: 'docker',
      args: [...dockerBaseArgs(launcher.context), 'exec', launcher.container, 'mkdir', '-p', plan.binDir],
    },
    what,
  );
}

async function uploadToRemote(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  plan: RemoteBinPlan,
  localPath: string,
  runner: LocalRunner,
  artifact: ExecutorArtifact,
): Promise<void> {
  const what = `uploading the executor to ${launcherLabel(launcher)}`;
  if (launcher.type === 'ssh') {
    // The scp target must be a verbatim absolute path: OpenSSH ≥ 9.0 scp
    // speaks SFTP by default — no remote shell, no `$HOME`/`~` expansion.
    await runStep(
      'upload',
      runner,
      {
        program: 'scp',
        args: [...SSH_CONFIG_OPTIONS, localPath, `${launcher.host}:${plan.tmp}`],
        timeoutMs: UPLOAD_TIMEOUT_MS,
      },
      what,
      artifact,
    );
    return;
  }
  await runStep(
    'upload',
    runner,
    {
      program: 'docker',
      args: [...dockerBaseArgs(launcher.context), 'cp', localPath, `${launcher.container}:${plan.tmp}`],
      timeoutMs: UPLOAD_TIMEOUT_MS,
    },
    what,
    artifact,
  );
}

async function activateRemote(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  plan: RemoteBinPlan,
  runner: LocalRunner,
  artifact: ExecutorArtifact,
): Promise<void> {
  const what = `activating the executor on ${launcherLabel(launcher)}`;
  if (launcher.type === 'ssh') {
    // ssh joins argv with spaces, so the remote command is one pre-quoted
    // string; chmod-then-mv keeps the destination atomic (tmp + rename).
    await runStep(
      'activate',
      runner,
      {
        program: 'ssh',
        args: [
          ...sshBaseArgs(),
          launcher.host,
          `chmod 755 ${shQuote(plan.tmp)} && mv -f ${shQuote(plan.tmp)} ${shQuote(plan.dest)}`,
        ],
      },
      what,
      artifact,
    );
    return;
  }
  await runStep(
    'activate',
    runner,
    {
      program: 'docker',
      args: [
        ...dockerBaseArgs(launcher.context),
        'exec',
        launcher.container,
        'sh',
        '-c',
        'chmod 755 "$1" && mv -f "$1" "$2"',
        'kimi-install',
        plan.tmp,
        plan.dest,
      ],
    },
    what,
    artifact,
  );
}

async function cleanupRemote(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  plan: RemoteBinPlan,
  runner: LocalRunner,
): Promise<void> {
  const request: LocalRunRequest =
    launcher.type === 'ssh'
      ? {
          program: 'ssh',
          args: [...sshBaseArgs(), launcher.host, `rm -f ${shQuote(plan.tmp)}`],
        }
      : {
          program: 'docker',
          args: [...dockerBaseArgs(launcher.context), 'exec', launcher.container, 'rm', '-f', plan.tmp],
        };
  await runner(request).catch(() => {});
}

export interface InstallExecutorOptions {
  readonly launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' };
  readonly locator: ExecutorArtifactLocator;
  readonly version: string;
  readonly minExecutorVersion?: string;
  readonly runner?: LocalRunner;
  readonly fetchImpl?: typeof fetch;
  readonly onProgress?: (line: string) => void;
}

export interface ExecutorInstallResult {
  readonly remoteBin: string;
  readonly version: string;
  readonly target: string;
  readonly alreadyInstalled: boolean;
}

// Installs (or repairs) the remote executor for a typed ssh/docker environment:
// probe the target environment → skip when a usable executor is already at the
// destination → locate the SEA artifact → download with pinned SHA-256
// verification → upload to a unique tmp path → chmod + atomic rename → verify
// the installed binary runs `--version` at or above the minimum. A failure
// before the rename never presents as success, and the stale tmp file is
// removed best-effort, so a half-install is always diagnosable.
export async function installExecutor(
  options: InstallExecutorOptions,
): Promise<ExecutorInstallResult> {
  const launcher = options.launcher;
  const runner = options.runner ?? defaultLocalRunner;
  const progress = options.onProgress ?? ((): void => {});
  const minVersion = options.minExecutorVersion ?? MIN_EXECUTOR_VERSION;
  const label = launcherLabel(launcher);

  progress(`probing the target environment on ${label}...`);
  const probed = await probeRemoteEnvironment(launcher, runner);
  const key = releaseTargetKey(probed.target);
  if (key === undefined) {
    throw new ExecutorInstallError(
      'probe',
      `unsupported executor target ${probed.target.osKind}/${probed.target.osArch} on ${label} ` +
        '(the executor is posix-only; supported targets are linux/darwin on x64/arm64)',
    );
  }
  const plan = remoteBinPlan(launcher, probed.homeDir);

  const existing = await probeInstalledVersion(launcher, plan, runner);
  if (existing !== undefined && compareVersions(existing, minVersion) >= 0) {
    progress(`executor ${existing} is already installed at ${plan.invokePath}`);
    return { remoteBin: plan.invokePath, version: existing, target: key, alreadyInstalled: true };
  }
  if (existing !== undefined) {
    progress(
      `executor at ${plan.invokePath} reports ${existing}, below the minimum ${minVersion} — reinstalling`,
    );
  }

  progress(`locating the executor artifact for ${key} (version ${options.version})...`);
  let artifact: ExecutorArtifact;
  try {
    artifact = await options.locator.locate(probed.target, options.version);
  } catch (error) {
    throw new ExecutorInstallError('locate', errorMessage(error), { cause: error });
  }

  const destDir = await mkdtemp(join(tmpdir(), 'kimi-executor-'));
  try {
    progress(`downloading ${artifact.filename} (${artifact.url})...`);
    let downloaded: DownloadedExecutorArtifact;
    try {
      downloaded = await downloadExecutorArtifact(artifact, {
        fetchImpl: options.fetchImpl,
        destDir,
      });
    } catch (error) {
      throw new ExecutorInstallError('download', errorMessage(error), {
        cause: error,
        artifact,
      });
    }
    progress(`verified sha256 ${artifact.sha256} (${String(downloaded.sizeBytes)} bytes)`);

    await prepareRemote(launcher, plan, runner);
    try {
      await uploadToRemote(launcher, plan, downloaded.path, runner, artifact);
      await activateRemote(launcher, plan, runner, artifact);
    } catch (error) {
      await cleanupRemote(launcher, plan, runner);
      throw error;
    }
  } finally {
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
  }

  const installed = await probeInstalledVersion(launcher, plan, runner);
  if (installed === undefined) {
    throw new ExecutorInstallError(
      'post-check',
      `executor was installed to ${plan.invokePath} on ${label} but failed to run \`--version\``,
      { artifact },
    );
  }
  if (compareVersions(installed, minVersion) < 0) {
    throw new ExecutorInstallError(
      'post-check',
      `executor installed to ${plan.invokePath} on ${label} reports version ${installed}, ` +
        `below the minimum ${minVersion}`,
      { artifact },
    );
  }
  progress(`executor ${installed} installed at ${plan.invokePath}`);
  return { remoteBin: plan.invokePath, version: installed, target: key, alreadyInstalled: false };
}
