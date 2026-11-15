import { join } from 'node:path';

export const ARTEX_ROOT_DIR = '.artex';
export const ARTEX_EXPLORATIONS_DIR = 'explorations';
export const ARTEX_STATE_FILE = 'state.json';
export const ARTEX_ACTIVITY_LOG = 'activity.log';
export const ARTEX_STATE_LOCK_SUFFIX = '.lock';
export const ARTEX_WORK_STORE_FILE = 'work-store.json';

export const ARTEX_STATE_SCHEMA_VERSION = 1;
export const ARTEX_WORK_STORE_SCHEMA_VERSION = 1;

export function artexRootDir(workspaceRoot: string): string {
  return join(workspaceRoot, ARTEX_ROOT_DIR);
}

export function artexWorkStoreFile(workspaceRoot: string): string {
  return join(artexRootDir(workspaceRoot), ARTEX_WORK_STORE_FILE);
}

export function artexWorkStoreLockPath(workspaceRoot: string): string {
  return `${artexWorkStoreFile(workspaceRoot)}${ARTEX_STATE_LOCK_SUFFIX}`;
}

export function artexExplorationDir(workspaceRoot: string, explorationId: number): string {
  return join(artexRootDir(workspaceRoot), ARTEX_EXPLORATIONS_DIR, String(explorationId));
}

export function artexStateFile(workspaceRoot: string, explorationId: number): string {
  return join(artexExplorationDir(workspaceRoot, explorationId), ARTEX_STATE_FILE);
}

export function artexActivityLog(workspaceRoot: string, explorationId: number): string {
  return join(artexExplorationDir(workspaceRoot, explorationId), ARTEX_ACTIVITY_LOG);
}

export function artexStateLockPath(workspaceRoot: string, explorationId: number): string {
  return `${artexStateFile(workspaceRoot, explorationId)}${ARTEX_STATE_LOCK_SUFFIX}`;
}
