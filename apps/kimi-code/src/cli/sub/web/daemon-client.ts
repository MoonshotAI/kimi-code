import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, symlink } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  ErrorCode,
  readDaemonRemoteControlPreference,
  writeDaemonRemoteControlPreference,
} from '@moonshot-ai/kap-server';
import { RemoteControlAlreadyRunningError, resolveRemoteControlRelayOrigin } from '@moonshot-ai/remote-control';

import { detectNativeInstall } from '../../update/source';
import { getVersion } from '../../version';
import { pidAlive, signalPid } from './legacy-kill';

const LOCK_FILE = 'daemon.lock';
const STATE_FILE = 'daemon.json';
const LOG_FILE = 'daemon.log';
const SOCKET_FILE = 'daemon.sock';
const AGENT_SOCKET_FILE = 'forwarded-ssh-agent.sock';

const POLL_INTERVAL_MS = 100;
const LOCK_MAX_ATTEMPTS = 450;
const START_MAX_ATTEMPTS = 300;
const REQUEST_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;

const MANAGED_DAEMON_ENV_KEYS = [
  'KIMI_CODE_PASSWORD',
  'KIMI_CODE_ALLOWED_HOSTS',
  'KIMI_CODE_DISABLE_HOST_CHECK',
  'KIMI_CODE_CORS_ORIGINS',
  'KIMI_CODE_REMOTE_CONTROL_RELAY_URL',
  'KIMI_CODE_BASE_URL',
  'KIMI_API_KEY',
  'KIMI_MODEL_NAME',
  'KIMI_CODE_GLOBAL_SEARCH',
  'KIMI_CODE_SESSION_IDLE_RECLAIM_MS',
  'KIMI_CODE_PLUGIN_MARKETPLACE_URL',
  'KIMI_DISABLE_TELEMETRY',
  'KIMI_CODE_FEEDBACK_BASE_URL',
  'KIMI_CODE_EXPERIMENTAL_FLAG',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
] as const;

export interface DaemonStateRecord {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly socketPath: string;
  readonly logPath: string;
  readonly startedAt: string;
  readonly version: string;
  readonly kapVersion: number;
  readonly envHashes: Readonly<Record<string, string>>;
}

export interface RunningDaemonInfo {
  readonly pid?: number;
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly socketPath: string;
  readonly logPath: string;
  readonly startedAt: string;
  readonly version: string;
  readonly kapVersion: number;
  readonly envHashes?: Readonly<Record<string, string>>;
}

export interface EnsureSharedDaemonResult {
  readonly daemon: RunningDaemonInfo;
  readonly started: boolean;
  readonly reusedBusyMismatch: boolean;
}

export interface DaemonRemoteControlReady {
  readonly url: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly relayOrigin: string;
}

export interface DaemonActiveSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly activity: string;
  readonly workspaceRoot?: string;
}

export interface DaemonStatusSnapshot {
  readonly running: boolean;
  readonly daemon?: RunningDaemonInfo;
  readonly remoteControl?: {
    readonly enabled: boolean;
    readonly state: string;
    readonly url?: string;
    readonly deviceName?: string;
    readonly error?: string;
  };
  readonly persistedRemoteControl: boolean;
  readonly activeSessions: readonly DaemonActiveSessionSummary[];
  readonly logPath: string;
}

export class DaemonEnvMismatchError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(
      `Environment variable(s) ${keys.join(', ')} differ from the running Kimi daemon. Run 'kimi daemon restart' to apply the current environment, or pass '--no-daemon' to run an independent server.`,
    );
    this.name = 'DaemonEnvMismatchError';
  }
}

export class DaemonBusyStopError extends Error {
  constructor(readonly activeCount: number) {
    super(
      `Kimi daemon has ${String(activeCount)} active session(s) running work. Pass '--force' to stop it anyway.`,
    );
    this.name = 'DaemonBusyStopError';
  }
}

export function isSharedDaemonSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

export function daemonServerDir(homeDir: string): string {
  return join(homeDir, 'server');
}

export function daemonLockPath(homeDir: string): string {
  return join(daemonServerDir(homeDir), LOCK_FILE);
}

export function daemonStatePath(homeDir: string): string {
  return join(daemonServerDir(homeDir), STATE_FILE);
}

export function daemonLogPath(homeDir: string): string {
  return join(daemonServerDir(homeDir), LOG_FILE);
}

export function agentSocketPath(homeDir: string): string {
  return join(daemonServerDir(homeDir), AGENT_SOCKET_FILE);
}

export function daemonSocketPath(homeDir: string): string {
  const direct = join(daemonServerDir(homeDir), SOCKET_FILE);
  if (Buffer.byteLength(direct) <= 100) return direct;
  const hash = createHash('sha256').update(homeDir).digest('hex').slice(0, 16);
  return join(tmpdir(), `kimi-daemon-${hash}`, SOCKET_FILE);
}

function isManagedEnvKey(key: string): boolean {
  return (
    (MANAGED_DAEMON_ENV_KEYS as readonly string[]).includes(key) ||
    key.startsWith('KIMI_CODE_EXPERIMENTAL_') ||
    key.startsWith('KIMI_MODEL_')
  );
}

export function computeManagedDaemonEnvHashes(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const key of Object.keys(env).toSorted()) {
    if (!isManagedEnvKey(key)) continue;
    const value = env[key];
    if (value === undefined || value === '') continue;
    hashes[key] = createHash('sha256').update(value).digest('hex');
  }
  return hashes;
}

export function diffManagedDaemonEnv(
  currentEnv: NodeJS.ProcessEnv,
  daemonHashes: Readonly<Record<string, string>>,
): string[] {
  const current = computeManagedDaemonEnvHashes(currentEnv);
  const allKeys = new Set([...Object.keys(current), ...Object.keys(daemonHashes)]);
  return [...allKeys].toSorted().filter((key) => current[key] !== daemonHashes[key]);
}

export async function syncForwardedAgentSocket(
  homeDir: string,
  sshAuthSock: string | undefined,
): Promise<void> {
  const linkPath = agentSocketPath(homeDir);
  if (sshAuthSock === undefined || sshAuthSock.length === 0 || sshAuthSock === linkPath) return;
  const dir = dirname(linkPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const temp = `${linkPath}.${process.pid}.tmp`;
  await rm(temp, { force: true });
  await symlink(sshAuthSock, temp);
  await rename(temp, linkPath);
}

export async function acquireDaemonLock(
  lockPath: string,
  wait: (ms: number) => Promise<void> = (ms) => sleep(ms),
): Promise<() => Promise<void>> {
  const dir = dirname(lockPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      let written = false;
      try {
        await handle.writeFile(String(process.pid));
        written = true;
      } finally {
        await handle.close();
        if (!written) await rm(lockPath, { force: true });
      }
      return () => rm(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10);
      if ((!Number.isNaN(holder) && !pidAlive(holder)) || (Number.isNaN(holder) && attempt > 0)) {
        await rm(lockPath, { force: true });
      } else {
        await wait(POLL_INTERVAL_MS);
      }
    }
  }
  throw new Error(`timed out waiting for ${lockPath}`);
}

export async function writeDaemonState(homeDir: string, record: DaemonStateRecord): Promise<void> {
  const filePath = daemonStatePath(homeDir);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w', 0o600);
    try {
      await fh.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    } finally {
      await fh.close();
    }
    await rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await rm(tmpPath, { force: true });
    }
  }
}

export async function readDaemonState(homeDir: string): Promise<DaemonStateRecord | undefined> {
  try {
    const raw = await readFile(daemonStatePath(homeDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonStateRecord>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.host === 'string' &&
      typeof parsed.port === 'number' &&
      typeof parsed.origin === 'string' &&
      typeof parsed.socketPath === 'string' &&
      typeof parsed.logPath === 'string' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.version === 'string'
    ) {
      const rawHashes = parsed.envHashes;
      const envHashes: Record<string, string> = {};
      if (typeof rawHashes === 'object' && rawHashes !== null) {
        for (const [key, val] of Object.entries(rawHashes)) {
          if (typeof val === 'string') envHashes[key] = val;
        }
      }
      return {
        pid: parsed.pid,
        host: parsed.host,
        port: parsed.port,
        origin: parsed.origin,
        socketPath: parsed.socketPath,
        logPath: parsed.logPath,
        startedAt: parsed.startedAt,
        version: parsed.version,
        kapVersion: typeof parsed.kapVersion === 'number' ? parsed.kapVersion : 1,
        envHashes,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function removeDaemonStateForPid(homeDir: string, pid: number): Promise<void> {
  const existing = await readDaemonState(homeDir);
  if (existing?.pid === pid) {
    await rm(daemonStatePath(homeDir), { force: true });
  }
}

interface KapEnvelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
  readonly details?: unknown;
}

export function daemonHttpRequest<T>(
  socketPath: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ readonly status: number; readonly envelope: KapEnvelope<T> } | undefined> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const req = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: {
          host: '127.0.0.1',
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(payload.length),
              }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          let envelope: KapEnvelope<T> | undefined;
          try {
            envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as KapEnvelope<T>;
          } catch {
            envelope = undefined;
          }
          resolve(
            envelope === undefined ? undefined : { status: res.statusCode ?? 500, envelope },
          );
        });
        res.on('error', () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      resolve(undefined);
    }, timeoutMs);
    req.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

interface MetaWire {
  readonly server_version?: string;
  readonly kap_version?: number;
  readonly started_at?: string;
}

export async function probeRunningDaemon(homeDir: string): Promise<RunningDaemonInfo | undefined> {
  const socketPath = daemonSocketPath(homeDir);
  const metaRes = await daemonHttpRequest<MetaWire>(socketPath, 'GET', '/api/v1/meta', undefined, 2_000);
  if (metaRes === undefined || metaRes.status !== 200 || metaRes.envelope.code !== 0) {
    return undefined;
  }
  const meta = metaRes.envelope.data;
  if (meta?.server_version === undefined) return undefined;
  const state = await readDaemonState(homeDir);
  const liveState = state !== undefined && pidAlive(state.pid) ? state : undefined;
  const host = liveState?.host ?? '127.0.0.1';
  const port = liveState?.port ?? 58627;
  return {
    pid: liveState?.pid,
    host,
    port,
    origin: liveState?.origin ?? `http://${host}:${String(port)}`,
    socketPath,
    logPath: liveState?.logPath ?? daemonLogPath(homeDir),
    startedAt: meta.started_at ?? liveState?.startedAt ?? '',
    version: meta.server_version,
    kapVersion: meta.kap_version ?? liveState?.kapVersion ?? 1,
    envHashes: liveState?.envHashes,
  };
}

export function spawnDetachedDaemonProcess(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
  paths?: { readonly logPath?: string; readonly agentSocket?: string },
): void {
  const logPath = paths?.logPath ?? daemonLogPath(homeDir);
  const agentSocket = paths?.agentSocket ?? agentSocketPath(homeDir);
  const argv = detectNativeInstall()
    ? [process.execPath]
    : [process.execPath, ...process.execArgv, process.argv[1]!];
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(argv[0]!, [...argv.slice(1), 'server', '--daemon-server'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...env, SSH_AUTH_SOCK: agentSocket },
    });
    child.on('error', () => {});
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`unable to start the Kimi daemon; see ${logPath}`);
    }
  } finally {
    closeSync(logFd);
  }
}

export interface EnsureSharedDaemonOptions {
  readonly homeDir: string;
  readonly version?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly checkEnv?: boolean;
  readonly spawnDaemon?: (homeDir: string, env: NodeJS.ProcessEnv) => void;
  readonly probeDaemon?: (homeDir: string) => Promise<RunningDaemonInfo | undefined>;
  readonly requestStopIfIdle?: (socketPath: string) => Promise<boolean>;
  readonly wait?: (ms: number) => Promise<void>;
}

async function defaultStopIfIdle(socketPath: string): Promise<boolean> {
  const res = await daemonHttpRequest<{ ok?: boolean }>(
    socketPath,
    'POST',
    '/api/v1/shutdown?if_idle=true',
    undefined,
    3_000,
  );
  return res?.status === 200 && res.envelope.code === 0 && res.envelope.data?.ok === true;
}

export interface EnsureDaemonProcessOptions<T extends { readonly version: string }> {
  readonly homeDir: string;
  readonly version: string;
  readonly sshAuthSock?: string;
  readonly pollIntervalMs: number;
  readonly maxAttempts: number;
  readonly probe: () => Promise<T | undefined>;
  readonly stopIfIdle: (existing: T) => Promise<boolean>;
  readonly closeProbe?: (item: T) => void;
  readonly beforeReuse?: (existing: T) => void;
  readonly spawn: () => void;
  readonly wait: (ms: number) => Promise<void>;
  readonly onLockError?: (error: unknown) => never;
  readonly onShutdownTimeout: () => Error;
  readonly onStartTimeout: () => Error;
}

export async function ensureDaemonProcess<T extends { readonly version: string }>(
  options: EnsureDaemonProcessOptions<T>,
): Promise<{ readonly daemon: T; readonly started: boolean; readonly reusedBusyMismatch: boolean }> {
  let release: () => Promise<void>;
  try {
    release = await acquireDaemonLock(daemonLockPath(options.homeDir), options.wait);
  } catch (error) {
    if (options.onLockError !== undefined) options.onLockError(error);
    throw error;
  }
  try {
    await syncForwardedAgentSocket(options.homeDir, options.sshAuthSock);
    const existing = await options.probe();
    if (existing !== undefined) {
      options.beforeReuse?.(existing);
      if (existing.version === options.version) {
        return { daemon: existing, started: false, reusedBusyMismatch: false };
      }
      if (!(await options.stopIfIdle(existing))) {
        return { daemon: existing, started: false, reusedBusyMismatch: true };
      }
      options.closeProbe?.(existing);
      let closed = false;
      for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
        const probe = await options.probe();
        if (probe === undefined) {
          closed = true;
          break;
        }
        options.closeProbe?.(probe);
        await options.wait(options.pollIntervalMs);
      }
      if (!closed) throw options.onShutdownTimeout();
    }
    options.spawn();
    for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
      const started = await options.probe();
      if (started !== undefined) {
        return { daemon: started, started: true, reusedBusyMismatch: false };
      }
      await options.wait(options.pollIntervalMs);
    }
    throw options.onStartTimeout();
  } finally {
    await release();
  }
}

export async function ensureSharedDaemon(
  options: EnsureSharedDaemonOptions,
): Promise<EnsureSharedDaemonResult> {
  const version = options.version ?? getVersion();
  const env = options.env ?? process.env;
  const wait = options.wait ?? ((ms: number) => sleep(ms));
  const probe = options.probeDaemon ?? probeRunningDaemon;
  const spawnDaemon = options.spawnDaemon ?? spawnDetachedDaemonProcess;
  const stopIfIdle = options.requestStopIfIdle ?? defaultStopIfIdle;

  return ensureDaemonProcess({
    homeDir: options.homeDir,
    version,
    sshAuthSock: env['SSH_AUTH_SOCK'],
    pollIntervalMs: POLL_INTERVAL_MS,
    maxAttempts: START_MAX_ATTEMPTS,
    probe: () => probe(options.homeDir),
    stopIfIdle: (existing) => stopIfIdle(existing.socketPath),
    beforeReuse: (existing) => {
      if (options.checkEnv === true && existing.envHashes !== undefined) {
        const changed = diffManagedDaemonEnv(env, existing.envHashes);
        if (changed.length > 0) throw new DaemonEnvMismatchError(changed);
      }
    },
    spawn: () => spawnDaemon(options.homeDir, env),
    wait,
    onShutdownTimeout: () => new Error('the previous Kimi daemon did not shut down in time'),
    onStartTimeout: () =>
      new Error(`the Kimi daemon did not start; see ${daemonLogPath(options.homeDir)}`),
  });
}

interface RemoteControlStatusWire {
  readonly enabled: boolean;
  readonly state: string;
  readonly url?: string;
  readonly device_id?: string;
  readonly device_name?: string;
  readonly error?: string;
  readonly conflict?: {
    readonly pid: number;
    readonly local_origin: string;
    readonly device_id: string;
    readonly url: string;
    readonly started_at: number;
  };
}

interface RemoteControlConflictDetails {
  readonly pid: number;
  readonly local_origin: string;
  readonly device_id: string;
  readonly url: string;
  readonly started_at: number;
}

export async function enableDaemonRemoteControl(
  socketPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DaemonRemoteControlReady> {
  const res = await daemonHttpRequest<RemoteControlStatusWire>(
    socketPath,
    'POST',
    '/api/v1/remote-control',
    { enabled: true },
    30_000,
  );
  if (res === undefined) {
    throw new Error('Unable to reach the Kimi daemon to enable Remote Control.');
  }
  if (
    res.envelope.code === ErrorCode.REMOTE_CONTROL_ALREADY_RUNNING &&
    typeof res.envelope.details === 'object' &&
    res.envelope.details !== null
  ) {
    const details = res.envelope.details as RemoteControlConflictDetails;
    throw new RemoteControlAlreadyRunningError({
      pid: details.pid,
      nonce: '',
      localOrigin: details.local_origin,
      deviceId: details.device_id,
      url: details.url,
      startedAt: details.started_at,
    });
  }
  if (res.status !== 200 || res.envelope.code !== 0) {
    throw new Error(res.envelope.msg || 'Failed to enable Remote Control on the Kimi daemon.');
  }
  const data = res.envelope.data;
  if (!data.enabled || data.url === undefined || data.device_id === undefined) {
    throw new Error(data.error ?? 'Remote Control did not finish starting.');
  }
  let relayOrigin = resolveRemoteControlRelayOrigin(env);
  try {
    relayOrigin = new URL(data.url).origin;
  } catch {
  }
  return {
    url: data.url,
    deviceId: data.device_id,
    deviceName: data.device_name ?? '',
    relayOrigin,
  };
}

export async function stopDaemonRemoteControl(homeDir: string): Promise<boolean> {
  await writeDaemonRemoteControlPreference(homeDir, false);
  const socketPath = daemonSocketPath(homeDir);
  const statusRes = await daemonHttpRequest<RemoteControlStatusWire>(
    socketPath,
    'GET',
    '/api/v1/remote-control',
    undefined,
    2_000,
  );
  if (statusRes === undefined || statusRes.status !== 200 || statusRes.envelope.code !== 0) {
    return false;
  }
  const wasActive = statusRes.envelope.data.state !== 'off';
  const disableRes = await daemonHttpRequest<RemoteControlStatusWire>(
    socketPath,
    'POST',
    '/api/v1/remote-control',
    { enabled: false },
    10_000,
  );
  if (disableRes !== undefined && (disableRes.status !== 200 || disableRes.envelope.code !== 0)) {
    throw new Error(disableRes.envelope.msg || 'Failed to stop Remote Control.');
  }
  return wasActive;
}

interface BusySessionsWire {
  readonly items?: ReadonlyArray<{
    readonly id: string;
    readonly title?: string;
    readonly activity?: string;
    readonly workspace_root?: string;
  }>;
}

export async function listDaemonActiveSessions(
  socketPath: string,
): Promise<readonly DaemonActiveSessionSummary[]> {
  const res = await daemonHttpRequest<BusySessionsWire>(
    socketPath,
    'GET',
    '/api/v1/sessions?busy=true&page_size=50',
    undefined,
    3_000,
  );
  if (res === undefined || res.status !== 200 || res.envelope.code !== 0) return [];
  return (res.envelope.data.items ?? []).map((item) => ({
    id: item.id,
    title: item.title ?? '',
    activity: item.activity ?? 'turn',
    workspaceRoot: item.workspace_root,
  }));
}

export async function getDaemonStatusSnapshot(homeDir: string): Promise<DaemonStatusSnapshot> {
  const persistedRemoteControl = await readDaemonRemoteControlPreference(homeDir);
  const logPath = daemonLogPath(homeDir);
  const daemon = await probeRunningDaemon(homeDir);
  if (daemon === undefined) {
    return {
      running: false,
      persistedRemoteControl,
      activeSessions: [],
      logPath,
    };
  }
  const [rcRes, activeSessions] = await Promise.all([
    daemonHttpRequest<RemoteControlStatusWire>(
      daemon.socketPath,
      'GET',
      '/api/v1/remote-control',
      undefined,
      2_000,
    ),
    listDaemonActiveSessions(daemon.socketPath),
  ]);
  const rc =
    rcRes !== undefined && rcRes.status === 200 && rcRes.envelope.code === 0
      ? {
          enabled: rcRes.envelope.data.enabled,
          state: rcRes.envelope.data.state,
          url: rcRes.envelope.data.url,
          deviceName: rcRes.envelope.data.device_name,
          error: rcRes.envelope.data.error,
        }
      : undefined;
  return {
    running: true,
    daemon,
    remoteControl: rc,
    persistedRemoteControl,
    activeSessions,
    logPath: daemon.logPath,
  };
}

export interface ConfirmBusyStopOptions {
  readonly activeSessions: readonly DaemonActiveSessionSummary[];
}

export async function confirmStopOnTty(
  activeSessions: readonly DaemonActiveSessionSummary[],
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Kimi daemon has ${String(activeSessions.length)} active session(s) running work. Stop it anyway? [y/N] `,
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

export interface StopSharedDaemonOptions {
  readonly homeDir: string;
  readonly force?: boolean;
  readonly confirmBusy?: (active: readonly DaemonActiveSessionSummary[]) => Promise<boolean>;
  readonly wait?: (ms: number) => Promise<void>;
}

export interface StopSharedDaemonResult {
  readonly outcome: 'not_running' | 'cancelled' | 'stopped' | 'killed';
  readonly pid?: number;
}

async function waitForDaemonExit(
  homeDir: string,
  pid: number | undefined,
  timeoutMs: number,
  wait: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const pidDead = pid === undefined || !pidAlive(pid);
    const probed = pidDead ? await probeRunningDaemon(homeDir) : undefined;
    if (pidDead && probed === undefined) return true;
    await wait(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  if (pid !== undefined && pidAlive(pid)) return false;
  return (await probeRunningDaemon(homeDir)) === undefined;
}

export async function stopSharedDaemon(
  options: StopSharedDaemonOptions,
): Promise<StopSharedDaemonResult> {
  const wait = options.wait ?? ((ms: number) => sleep(ms));
  const release = await acquireDaemonLock(daemonLockPath(options.homeDir), wait);
  try {
    const daemon = await probeRunningDaemon(options.homeDir);
    const state = await readDaemonState(options.homeDir);
    const pid = daemon?.pid ?? (state !== undefined && pidAlive(state.pid) ? state.pid : undefined);
    if (daemon === undefined && pid === undefined) {
      await rm(daemonStatePath(options.homeDir), { force: true });
      await rm(daemonSocketPath(options.homeDir), { force: true });
      return { outcome: 'not_running' };
    }

    if (options.force !== true && daemon !== undefined) {
      const active = await listDaemonActiveSessions(daemon.socketPath);
      if (active.length > 0) {
        const confirm = options.confirmBusy ?? confirmStopOnTty;
        if (!process.stdin.isTTY && options.confirmBusy === undefined) {
          throw new DaemonBusyStopError(active.length);
        }
        const confirmed = await confirm(active);
        if (!confirmed) {
          return { outcome: 'cancelled', pid };
        }
      }
    }

    const socketPath = daemon?.socketPath ?? daemonSocketPath(options.homeDir);
    const shutdownRes = await daemonHttpRequest<{ ok?: boolean }>(socketPath, 'POST', '/api/v1/shutdown', undefined, 2_000);
    const cleanupFiles = async (): Promise<void> => {
      await rm(daemonStatePath(options.homeDir), { force: true });
      await rm(socketPath, { force: true });
    };
    const httpAccepted = shutdownRes?.status === 200 && shutdownRes.envelope.code === 0;
    if (httpAccepted && (await waitForDaemonExit(options.homeDir, pid, STOP_GRACE_MS, wait))) {
      await cleanupFiles();
      return { outcome: 'stopped', pid };
    }
    if (pid !== undefined) signalPid(pid, 'SIGTERM');
    if (await waitForDaemonExit(options.homeDir, pid, STOP_GRACE_MS, wait)) {
      await cleanupFiles();
      return { outcome: 'stopped', pid };
    }
    if (pid !== undefined) signalPid(pid, 'SIGKILL');
    if (await waitForDaemonExit(options.homeDir, pid, KILL_GRACE_MS, wait)) {
      await cleanupFiles();
      return { outcome: 'killed', pid };
    }

    throw new Error(
      `Failed to stop Kimi daemon${pid !== undefined ? ` (pid ${String(pid)})` : ''}; insufficient permissions?`,
    );
  } finally {
    await release();
  }
}

export async function restartSharedDaemon(
  options: StopSharedDaemonOptions & {
    readonly env?: NodeJS.ProcessEnv;
    readonly spawnDaemon?: (homeDir: string, env: NodeJS.ProcessEnv) => void;
    readonly probeDaemon?: (homeDir: string) => Promise<RunningDaemonInfo | undefined>;
  },
): Promise<
  | { readonly cancelled: true; readonly pid?: number }
  | { readonly cancelled: false; readonly daemon: RunningDaemonInfo }
> {
  const stopped = await stopSharedDaemon(options);
  if (stopped.outcome === 'cancelled') {
    return { cancelled: true, pid: stopped.pid };
  }
  const started = await ensureSharedDaemon({
    homeDir: options.homeDir,
    version: getVersion(),
    env: options.env,
    spawnDaemon: options.spawnDaemon,
    probeDaemon: options.probeDaemon,
    wait: options.wait,
  });
  return { cancelled: false, daemon: started.daemon };
}
