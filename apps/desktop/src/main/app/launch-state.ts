import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app } from 'electron';

import { launchChannel, launchId, log, logsDir, onStartupStep, uptimeMs } from '../diagnostics/log';
import type { PreviousLaunchAbnormalEvent } from '../diagnostics/telemetry-events';
import { trackDesktopEvent } from '../diagnostics/track';

const HEARTBEAT_MS = 5 * 60_000;

export interface LaunchRecord {
  launchId: string;
  pid: number;
  version: string;
  startedAt: number;
  updatedAt: number;
  stage: string;
  cleanExit: boolean;
  rendererGone: boolean;
  mainException: boolean;
}

export function launchStatePath(root: string, channel: string): string {
  return join(root, `desktop-launch-${channel}.json`);
}

export function asLaunchRecord(value: unknown): LaunchRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const strings = ['launchId', 'version', 'stage'] as const;
  const numbers = ['pid', 'startedAt', 'updatedAt'] as const;
  const flags = ['cleanExit', 'rendererGone', 'mainException'] as const;
  if (strings.some((key) => typeof record[key] !== 'string')) return null;
  if (numbers.some((key) => typeof record[key] !== 'number' || !Number.isFinite(record[key]))) return null;
  if (flags.some((key) => typeof record[key] !== 'boolean')) return null;
  return record as unknown as LaunchRecord;
}

export function evaluatePreviousLaunch(
  previous: LaunchRecord | null,
  currentVersion: string,
  isProcessAlive: (pid: number) => boolean,
): PreviousLaunchAbnormalEvent | null {
  if (previous === null || previous.cleanExit) return null;
  if (previous.pid !== process.pid && isProcessAlive(previous.pid)) return null;
  return {
    last_stage: previous.stage,
    uptime_ms: Math.max(0, Math.round(previous.updatedAt - previous.startedAt)),
    version_changed: previous.version !== currentVersion,
    renderer_gone: previous.rendererGone,
    main_exception: previous.mainException,
    previous_launch_id: previous.launchId,
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLaunchRecord(path: string): LaunchRecord | null {
  try {
    return asLaunchRecord(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return null;
  }
}

let statePath: string | null = null;
let current: LaunchRecord | null = null;

function persist(): void {
  if (statePath === null || current === null) return;
  current.updatedAt = Date.now();
  try {
    writeFileSync(statePath, JSON.stringify(current));
  } catch {
    return;
  }
}

function update(change: Partial<LaunchRecord>): void {
  if (current === null || current.cleanExit) return;
  Object.assign(current, change);
  persist();
}

export function markRendererGone(): void {
  update({ rendererGone: true });
}

export function markQuitStarted(): void {
  update({ stage: 'quitting' });
}

export function markCleanExit(): void {
  update({ stage: 'quit', cleanExit: true });
}

export function startLaunchTracking(isProcessAlive: (pid: number) => boolean = processAlive): void {
  if (current !== null) return;
  statePath = launchStatePath(logsDir(), launchChannel());
  const abnormal = evaluatePreviousLaunch(readLaunchRecord(statePath), app.getVersion(), isProcessAlive);
  if (abnormal !== null) {
    log.warn(
      `[startup] previous launch ${abnormal.previous_launch_id} ended abnormally stage=${abnormal.last_stage} uptime=${abnormal.uptime_ms}ms renderer_gone=${abnormal.renderer_gone} main_exception=${abnormal.main_exception}`,
    );
    trackDesktopEvent('previous_launch_abnormal', abnormal);
  }
  const now = Date.now();
  current = {
    launchId: launchId(),
    pid: process.pid,
    version: app.getVersion(),
    startedAt: now - uptimeMs(),
    updatedAt: now,
    stage: 'launched',
    cleanExit: false,
    rendererGone: false,
    mainException: false,
  };
  try {
    mkdirSync(dirname(statePath), { recursive: true });
  } catch {
    return;
  }
  persist();
  onStartupStep((entry) => {
    if (current?.stage !== 'quitting') update({ stage: entry.step });
  });
  const heartbeat = setInterval(() => update({}), HEARTBEAT_MS);
  heartbeat.unref?.();
  process.on('uncaughtException', () => update({ mainException: true }));
  process.on('unhandledRejection', () => update({ mainException: true }));
  app.on('will-quit', markCleanExit);
}
