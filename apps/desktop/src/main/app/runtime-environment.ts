import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { app } from 'electron';
import { releaseChannelName } from '../release/release-channel';
import {
  asRuntimeEnvironmentOverrides,
  RUNTIME_ENVIRONMENT_KEYS,
  type RuntimeEnvironmentKey,
  type RuntimeEnvironmentOverrides,
} from '../../shared/runtime-environment';

export class RuntimeEnvironmentFieldError extends Error {
  constructor(readonly field: RuntimeEnvironmentKey) {
    super(`Invalid value for ${field}`);
    this.name = 'RuntimeEnvironmentFieldError';
  }
}

export function runtimeEnvironmentCustomizationEnabled(version: string, isPackaged: boolean): boolean {
  return releaseChannelName(version, isPackaged) !== 'stable';
}

function defaultRuntimeEnvironmentFile(): string {
  return join(app.getPath('userData'), 'runtime-environment.json');
}

function normalizeEndpoint(value: string, field: RuntimeEnvironmentKey): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
      throw new RuntimeEnvironmentFieldError(field);
    }
    return value;
  } catch (error) {
    if (error instanceof RuntimeEnvironmentFieldError) throw error;
    throw new RuntimeEnvironmentFieldError(field);
  }
}

function normalizeHome(value: string): string {
  const expanded = value === '~'
    ? homedir()
    : /^~[\\/]/.test(value)
      ? join(homedir(), value.slice(2))
      : value;
  if (!isAbsolute(expanded) || expanded.includes('\0')) {
    throw new RuntimeEnvironmentFieldError('KIMI_CODE_HOME');
  }
  return resolve(expanded);
}

function normalizeRuntimeEnvironmentOverrides(value: unknown, requireEndpoints: boolean): RuntimeEnvironmentOverrides {
  const input = asRuntimeEnvironmentOverrides(value);
  if (input === null) throw new Error('Invalid runtime environment configuration');
  const overrides: RuntimeEnvironmentOverrides = {};
  for (const key of RUNTIME_ENVIRONMENT_KEYS) {
    const raw = input[key]?.trim();
    if (raw === undefined || raw === '') {
      if (requireEndpoints && key !== 'KIMI_CODE_HOME') throw new RuntimeEnvironmentFieldError(key);
      continue;
    }
    overrides[key] = key === 'KIMI_CODE_HOME' ? normalizeHome(raw) : normalizeEndpoint(raw, key);
  }
  return overrides;
}

export function readRuntimeEnvironmentOverrides(file: string = defaultRuntimeEnvironmentFile()): RuntimeEnvironmentOverrides {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return normalizeRuntimeEnvironmentOverrides(JSON.parse(raw), false);
}

export function writeRuntimeEnvironmentOverrides(
  value: unknown,
  file: string = defaultRuntimeEnvironmentFile(),
  requireEndpoints = true,
): RuntimeEnvironmentOverrides {
  const overrides = normalizeRuntimeEnvironmentOverrides(value, requireEndpoints);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(overrides, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return overrides;
}

const inheritedEnvironment = new Map<RuntimeEnvironmentKey, string | undefined>();

export function restoreRuntimeEnvironmentForRelaunch(): void {
  for (const [key, value] of inheritedEnvironment) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  inheritedEnvironment.clear();
}

export function applyRuntimeEnvironmentOverrides(): void {
  if (!runtimeEnvironmentCustomizationEnabled(app.getVersion(), app.isPackaged)) return;
  for (const key of RUNTIME_ENVIRONMENT_KEYS) {
    if (!inheritedEnvironment.has(key)) inheritedEnvironment.set(key, process.env[key]);
  }
  const overrides = readRuntimeEnvironmentOverrides();
  for (const key of RUNTIME_ENVIRONMENT_KEYS) {
    const value = overrides[key];
    if (value !== undefined) process.env[key] = value;
  }
}
