import { join } from 'node:path';

export const ARTEX_ROOT_DIR = '.artex';
export const ARTEX_EXPLORATIONS_DIR = 'explorations';
export const ARTEX_STATE_FILE = 'state.json';
export const ARTEX_ACTIVITY_LOG = 'activity.log';
export const ARTEX_ACTIVITY_SEQ_FILE = 'activity.seq';
export const ARTEX_STATE_LOCK_SUFFIX = '.lock';
export const ARTEX_WORK_STORE_FILE = 'work-store.json';

export const ARTEX_EVIDENCE_DIR = 'evidence';
export const ARTEX_EVIDENCE_BLOBS_DIR = 'blobs';
export const ARTEX_EVIDENCE_STAGING_DIR = '.staging';
export const ARTEX_TRAFFIC_DIR = 'traffic';
export const ARTEX_TRAFFIC_STORE_FILE = 'traffic-index.json';
export const ARTEX_TRAFFIC_CA_DIR = '_ca';

export const ARTEX_STATE_SCHEMA_VERSION = 1;
export const ARTEX_WORK_STORE_SCHEMA_VERSION = 1;
export const ARTEX_TRAFFIC_STORE_SCHEMA_VERSION = 1;

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

export function artexActivitySeqFile(workspaceRoot: string, explorationId: number): string {
  return join(artexExplorationDir(workspaceRoot, explorationId), ARTEX_ACTIVITY_SEQ_FILE);
}

export function artexActivityLockPath(workspaceRoot: string, explorationId: number): string {
  return `${artexActivityLog(workspaceRoot, explorationId)}${ARTEX_STATE_LOCK_SUFFIX}`;
}

export function artexStateLockPath(workspaceRoot: string, explorationId: number): string {
  return `${artexStateFile(workspaceRoot, explorationId)}${ARTEX_STATE_LOCK_SUFFIX}`;
}

export function artexEvidenceDir(workspaceRoot: string): string {
  return join(artexRootDir(workspaceRoot), ARTEX_EVIDENCE_DIR);
}

export function artexEvidenceBlobsDir(workspaceRoot: string): string {
  return join(artexEvidenceDir(workspaceRoot), ARTEX_EVIDENCE_BLOBS_DIR);
}

export function artexEvidenceStagingDir(workspaceRoot: string): string {
  return join(artexEvidenceDir(workspaceRoot), ARTEX_EVIDENCE_STAGING_DIR);
}

export function artexTrafficDir(workspaceRoot: string): string {
  return join(artexRootDir(workspaceRoot), ARTEX_TRAFFIC_DIR);
}

export function artexTrafficStoreFile(workspaceRoot: string): string {
  return join(artexTrafficDir(workspaceRoot), ARTEX_TRAFFIC_STORE_FILE);
}

export function artexTrafficStoreLockPath(workspaceRoot: string): string {
  return `${artexTrafficStoreFile(workspaceRoot)}${ARTEX_STATE_LOCK_SUFFIX}`;
}

export function artexTrafficCaDir(workspaceRoot: string): string {
  return join(artexTrafficDir(workspaceRoot), ARTEX_TRAFFIC_CA_DIR);
}
