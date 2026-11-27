import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';

export interface ProcessStamp {
  readonly pid: number;
  readonly hostname?: string;
  readonly startedAt: number;
  readonly liveness?: string;
}

interface ProcessProbe {
  readonly zombie: boolean;
  readonly startedAt?: number;
}

const CLOCK_TOLERANCE_MS = 5_000;

const PROBE_TIMEOUT_MS = 1_000;

const WINDOWS_PIPE_DIR = '\\\\.\\pipe\\';

const WINDOWS_LIVENESS_PREFIX = 'kimi-code-live-';

let processLivenessState: 'uninitialized' | 'ready' | 'unavailable' = 'uninitialized';

let processLivenessName: string | undefined;

export function currentProcessLiveness(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  if (processLivenessState === 'ready') return processLivenessName;
  if (processLivenessState === 'unavailable') return undefined;
  return startWindowsLivenessPipe();
}

export function processStampAlive(stamp: ProcessStamp, hostname = os.hostname()): boolean {
  if (stamp.hostname !== undefined && stamp.hostname !== '' && stamp.hostname !== hostname) return true;
  if (!Number.isSafeInteger(stamp.pid) || stamp.pid <= 0) return false;
  if (!Number.isFinite(stamp.startedAt)) return false;
  if (!signalable(stamp.pid)) return false;
  if (process.platform === 'win32' && stamp.liveness !== undefined && stamp.liveness !== '') {
    const alive = probeWindowsPipe(stamp.liveness);
    if (alive !== undefined) return alive;
  }
  if (stamp.startedAt < bootTime() - CLOCK_TOLERANCE_MS) return false;
  if (process.platform === 'win32') return true;
  const probe = probeProcess(stamp.pid);
  if (probe === undefined) return true;
  if (probe.zombie) return false;
  return probe.startedAt === undefined || probe.startedAt <= stamp.startedAt + CLOCK_TOLERANCE_MS;
}

function startWindowsLivenessPipe(): string | undefined {
  const name = `${WINDOWS_LIVENESS_PREFIX}${process.pid}-${randomBytes(16).toString('hex')}`;
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.destroy();
  });
  const invalidate = (): void => {
    if (processLivenessName !== name) return;
    processLivenessName = undefined;
    processLivenessState = 'unavailable';
  };
  server.on('error', () => {
    if (!server.listening) invalidate();
  });
  server.on('close', invalidate);
  try {
    server.listen({ path: `${WINDOWS_PIPE_DIR}${name}`, exclusive: true });
    server.unref();
  } catch {
    processLivenessState = 'unavailable';
    return undefined;
  }
  if (!server.listening) {
    processLivenessState = 'unavailable';
    return undefined;
  }
  if (probeWindowsPipe(name) !== true) {
    server.close();
    processLivenessState = 'unavailable';
    return undefined;
  }
  processLivenessName = name;
  processLivenessState = 'ready';
  return name;
}

function probeWindowsPipe(name: string): boolean | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(WINDOWS_PIPE_DIR);
  } catch {
    return undefined;
  }
  const target = name.toLowerCase();
  return entries.some((entry) => entry.toLowerCase() === target);
}

function signalable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function bootTime(): number {
  return Date.now() - os.uptime() * 1000;
}

function probeProcess(pid: number): ProcessProbe | undefined {
  let output: string;
  try {
    output = execFileSync('ps', ['-o', 'stat=', '-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
  const [stat, elapsed] = output.trim().split(/\s+/);
  if (stat === undefined || stat === '') return undefined;
  const elapsedSeconds = elapsed === undefined ? undefined : parseElapsedSeconds(elapsed);
  return {
    zombie: stat.startsWith('Z'),
    ...(elapsedSeconds === undefined ? {} : { startedAt: Date.now() - elapsedSeconds * 1000 }),
  };
}

function parseElapsedSeconds(elapsed: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(elapsed);
  if (match === null) return undefined;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}
