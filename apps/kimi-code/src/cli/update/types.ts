import { NPM_PACKAGE_NAME } from '#/constant/app';

export { NPM_PACKAGE_NAME };

/** Where the running CLI was installed from. Drives update command + spawn. */
export type InstallSource =
  | 'npm-global'
  | 'pnpm-global'
  | 'yarn-global'
  | 'bun-global'
  | 'native'
  | 'unsupported';

export interface UpdateTarget {
  readonly version: string;
}

export interface UpdateCache {
  readonly source: 'cdn';
  readonly checkedAt: string | null;
  readonly latest: string | null;
}

export interface UpdateInstallActive {
  readonly version: string;
  readonly source: InstallSource;
  readonly startedAt: string;
}

export interface UpdateInstallFailure {
  readonly version: string;
  readonly failedAt: string;
  readonly attempts: number;
}

export interface UpdateInstallSuccess {
  readonly version: string;
  readonly installedAt: string;
  readonly notifiedAt: string | null;
}

export interface UpdateInstallState {
  readonly active: UpdateInstallActive | null;
  readonly lastFailure: UpdateInstallFailure | null;
  readonly lastSuccess: UpdateInstallSuccess | null;
}

export type UpdateDecision = 'none' | 'prompt-install' | 'manual-command';
export type UpdatePreflightResult = 'continue' | 'exit';

export function emptyUpdateCache(): UpdateCache {
  return {
    source: 'cdn',
    checkedAt: null,
    latest: null,
  };
}

export function emptyUpdateInstallState(): UpdateInstallState {
  return {
    active: null,
    lastFailure: null,
    lastSuccess: null,
  };
}
