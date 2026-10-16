import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { dirname, join } from 'pathe';

import type { HostArgs } from '#/app/bootstrap/bootstrap';
import { ErrorCodes, Error2 } from '#/errors';

export type SessionRuntimeProcess = 'server' | 'cli' | 'cli-print';

export interface SessionRuntimeRecord {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly pid: number;
  readonly process: SessionRuntimeProcess;
  readonly startedAt: number;
  readonly ts: number;
  readonly stoppedAt?: number;
}

export interface SessionRuntimeEntry {
  readonly record: SessionRuntimeRecord;
  readonly active: boolean;
}

export const SESSION_RUNTIME_DIR_NAME = '.runtime';
export const SESSION_RUNTIME_HEARTBEAT_MS = 5_000;
export const SESSION_RUNTIME_ACTIVE_TTL_MS = 20_000;
export const SESSION_RUNTIME_STOPPED_RETENTION_MS = 48 * 3_600_000;
export const SESSION_RUNTIME_PRUNE_AGE_MS = 7 * 86_400_000;

export function sessionRuntimeDirOf(sessionsDir: string): string {
  return join(sessionsDir, SESSION_RUNTIME_DIR_NAME);
}

export function sessionRuntimePathOf(sessionsDir: string, sessionId: string): string {
  return join(sessionRuntimeDirOf(sessionsDir), `${sessionId}.json`);
}

export function resolveRuntimeProcess(args: HostArgs): SessionRuntimeProcess {
  if (args.nonInteractive === true) return 'cli-print';
  return args.hostKind ?? 'cli';
}

function isRuntimeProcess(value: unknown): value is SessionRuntimeProcess {
  return value === 'server' || value === 'cli' || value === 'cli-print';
}

function parseRuntimeRecord(raw: unknown): SessionRuntimeRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value['sessionId'] !== 'string' || value['sessionId'].length === 0) return undefined;
  if (typeof value['workspaceId'] !== 'string' || value['workspaceId'].length === 0) {
    return undefined;
  }
  if (typeof value['pid'] !== 'number' || !Number.isInteger(value['pid'])) return undefined;
  if (!isRuntimeProcess(value['process'])) return undefined;
  if (typeof value['startedAt'] !== 'number') return undefined;
  if (typeof value['ts'] !== 'number') return undefined;
  if (value['stoppedAt'] !== undefined && typeof value['stoppedAt'] !== 'number') {
    return undefined;
  }
  return value as unknown as SessionRuntimeRecord;
}

export function readSessionRuntimeRecord(filePath: string): SessionRuntimeRecord | undefined {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseRuntimeRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function isRuntimeRecordActive(record: SessionRuntimeRecord, now: number): boolean {
  return record.stoppedAt === undefined && now - record.ts <= SESSION_RUNTIME_ACTIVE_TTL_MS;
}

export function assertNoActiveRuntimeElsewhere(
  sessionsDir: string,
  sessionId: string,
  now: number = Date.now(),
): void {
  const record = readSessionRuntimeRecord(sessionRuntimePathOf(sessionsDir, sessionId));
  if (record === undefined) return;
  if (record.pid === process.pid) return;
  if (!isRuntimeRecordActive(record, now)) return;
  throw new Error2(
    ErrorCodes.SESSION_ACTIVE_IN_ANOTHER_PROCESS,
    `Session "${sessionId}" is active in another process (pid ${record.pid})`,
    { details: { pid: record.pid, process: record.process } },
  );
}

export function listSessionRuntimeEntries(
  sessionsDir: string,
  now: number = Date.now(),
): SessionRuntimeEntry[] {
  const dir = sessionRuntimeDirOf(sessionsDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: SessionRuntimeEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const filePath = join(dir, name);
    const record = readSessionRuntimeRecord(filePath);
    if (record === undefined) continue;
    if (now - record.ts > SESSION_RUNTIME_PRUNE_AGE_MS) {
      try {
        rmSync(filePath, { force: true });
      } catch {
      }
      continue;
    }
    if (record.process === 'server') continue;
    const active = isRuntimeRecordActive(record, now);
    const recentStopped =
      record.stoppedAt !== undefined &&
      now - record.stoppedAt <= SESSION_RUNTIME_STOPPED_RETENTION_MS;
    if (!active && !recentStopped) continue;
    entries.push({ record, active });
  }
  entries.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.record.ts - a.record.ts;
  });
  return entries;
}

function writeRuntimeRecordAtomic(filePath: string, record: SessionRuntimeRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(record)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

export class SessionRuntimeBeacon {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private readonly filePath: string;
  private readonly startedAt: number;

  constructor(
    sessionsDir: string,
    private readonly sessionId: string,
    private readonly workspaceId: string,
    private readonly processKind: SessionRuntimeProcess,
  ) {
    this.filePath = sessionRuntimePathOf(sessionsDir, sessionId);
    this.startedAt = Date.now();
  }

  start(): void {
    this.write(this.startedAt);
    this.timer = setInterval(() => {
      this.write(Date.now());
    }, SESSION_RUNTIME_HEARTBEAT_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.write(Date.now(), Date.now());
  }

  private write(ts: number, stoppedAt?: number): void {
    try {
      writeRuntimeRecordAtomic(this.filePath, {
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
        pid: process.pid,
        process: this.processKind,
        startedAt: this.startedAt,
        ts,
        stoppedAt,
      });
    } catch {
    }
  }
}
