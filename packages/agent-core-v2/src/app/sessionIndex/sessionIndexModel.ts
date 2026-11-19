import { posix } from 'node:path';

import { directoryKey, isWindowsAbsolutePath } from '#/_base/utils/paths';
import { environmentBindingId, LOCAL_ENVIRONMENT_ID, type EnvironmentBinding } from '#/environment/environment';

import type { SessionSummary } from './sessionIndex';

export const SESSION_INDEX_MANIFEST = 'sessionIndex';

export const SESSION_INDEX_SCHEMA_VERSION = 4;

export const WORKDIR_FIELD = 'workdirKey';
export const DIRECTORY_FIELD = 'directoryKey';

export const PARENT_INDEX_NAME = 'byParent';

export interface SessionWorkspaceCounts {
  readonly active: number;
  readonly archived: number;
}

export function sessionCollection(generation: number): string {
  return `session:g${generation}`;
}

export function sessionCountersCollection(generation: number): string {
  return `sessionCounters:g${generation}`;
}

export function recencyColumn(generation: number): string {
  return `g${generation}:updatedAt`;
}

export function workdirKey(workdir: Required<EnvironmentBinding>): string {
  const cwd = posix.isAbsolute(workdir.cwd) || isWindowsAbsolutePath(workdir.cwd)
    ? directoryKey(workdir.cwd)
    : workdir.cwd;
  return environmentBindingId(workdir.environmentId, cwd);
}

export function sessionWorkdirKey(summary: SessionSummary): string | undefined {
  const environmentId = summary.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const cwd = summary.environmentCwd ?? (environmentId === LOCAL_ENVIRONMENT_ID ? summary.cwd : undefined);
  if (!cwd || (environmentId === LOCAL_ENVIRONMENT_ID && !posix.isAbsolute(cwd) && !isWindowsAbsolutePath(cwd))) return undefined;
  return workdirKey({ environmentId, cwd });
}

export function withRecencyField(generation: number, summary: SessionSummary) {
  return {
    ...summary,
    [recencyColumn(generation)]: summary.updatedAt,
    [WORKDIR_FIELD]: sessionWorkdirKey(summary),
    [DIRECTORY_FIELD]: summary.cwd === undefined ? undefined : directoryKey(summary.cwd),
  };
}

export function stripRecencyField(generation: number, record: SessionSummary): SessionSummary {
  const key = recencyColumn(generation);
  if (!(key in record)) return record;
  const rest: Record<string, unknown> = { ...record };
  delete rest[key];
  delete rest[WORKDIR_FIELD];
  delete rest[DIRECTORY_FIELD];
  return rest as unknown as SessionSummary;
}
