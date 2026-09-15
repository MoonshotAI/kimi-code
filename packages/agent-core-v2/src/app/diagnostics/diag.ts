import { parseBooleanEnv } from '#/_base/utils/env';

export const DIAG_ENV = 'KIMI_CODE_DIAG';
export const REBUILD_ON_CONTENTION_ENV = 'KIMI_CODE_QUERY_STORE_REBUILD_ON_CONTENTION';

export function diagEnabled(): boolean {
  return parseBooleanEnv(process.env[DIAG_ENV]) === true;
}

export function rebuildOnContentionEnabled(): boolean {
  return parseBooleanEnv(process.env[REBUILD_ON_CONTENTION_ENV]) === true;
}
