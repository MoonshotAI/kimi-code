

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { installPlanPath } from './paths';
import type { InstallArgs } from './types';

const SUPERVISED_SERVER_HOST = '127.0.0.1';

export interface InstallPlan {

  host: string;

  port: number;

  logLevel: string;

  program: string;

  programArguments: string[];

  logPath: string;

  installedAt: string;
}

export interface BuildInstallPlanInput extends InstallArgs {

  program: string;

  logPath: string;

  nowIso?: string;
}


export function buildInstallPlan(input: BuildInstallPlanInput): InstallPlan {
  return {
    host: SUPERVISED_SERVER_HOST,
    port: input.port,
    logLevel: input.logLevel,
    program: input.program,
    programArguments: [
      input.program,
      'server',
      'run',
      '--port',
      String(input.port),
      '--log-level',
      input.logLevel,
      '--host',
      SUPERVISED_SERVER_HOST,
    ],
    logPath: input.logPath,
    installedAt: input.nowIso ?? new Date().toISOString(),
  };
}


export function writeInstallPlan(plan: InstallPlan, path: string = installPlanPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
}


export function readInstallPlan(path: string = installPlanPath()): InstallPlan | undefined {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isInstallPlan(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}


export function deleteInstallPlan(path: string = installPlanPath()): void {
  try {
    rmSync(path, { force: true });
  } catch {

  }
}

function isInstallPlan(value: unknown): value is InstallPlan {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['host'] === 'string' &&
    typeof v['port'] === 'number' &&
    typeof v['logLevel'] === 'string' &&
    typeof v['program'] === 'string' &&
    Array.isArray(v['programArguments']) &&
    (v['programArguments'] as unknown[]).every((arg) => typeof arg === 'string') &&
    typeof v['logPath'] === 'string' &&
    typeof v['installedAt'] === 'string'
  );
}
