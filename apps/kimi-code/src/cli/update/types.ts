import { NPM_PACKAGE_NAME } from '#/constant/app';

export { NPM_PACKAGE_NAME };

/** Where the running CLI was installed from. Drives update command + spawn. */
export type InstallSource =
  | 'npm-global'
  | 'pnpm-global'
  | 'yarn-global'
  | 'bun-global'
  | 'homebrew'
  | 'native'
  | 'unsupported';

export interface UpdateTarget {
  readonly version: string;
}

export const UPDATE_CHANNELS = ['stable', 'canary'] as const;

/** Release line the update surfaces follow, selected by `KIMI_CODE_UPDATE_CHANNEL`. */
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/**
 * The channel resolved once at the env boundary. `default` means the variable
 * is unset or empty; `invalid` keeps the rejected raw value for the warning.
 */
export type ChannelSelection =
  | { readonly channel: 'stable'; readonly origin: 'default' }
  | { readonly channel: UpdateChannel; readonly origin: 'env' }
  | { readonly channel: 'stable'; readonly origin: 'invalid'; readonly raw: string };

/**
 * Why an install runs. `switch-channel` is the only path allowed to install an
 * older version: `kimi update` leaving a canary build for the stable line.
 */
export type InstallIntent = 'upgrade' | 'switch-channel';

/** What `kimi update` does for the running version and the channel's latest. */
export type ManualUpdatePlan =
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'upgrade'; readonly target: UpdateTarget }
  | { readonly kind: 'switch-to-stable'; readonly target: UpdateTarget }
  | { readonly kind: 'canary-hold'; readonly stable: string };

/** One gradual-rollout cohort: `percent` of devices delayed by `delaySeconds`. */
export interface RolloutBatch {
  readonly percent: number;
  readonly delaySeconds: number;
}

/**
 * Parsed CDN `latest.json`. `rollout` batches claim bucket ranges in array
 * order; an empty array means the release is fully rolled out immediately.
 */
export interface UpdateManifest {
  readonly version: string;
  readonly publishedAt: string;
  readonly rollout: readonly RolloutBatch[];
}

export interface UpdateCache {
  readonly source: 'cdn';
  /** Channel the cached `latest` was fetched for; legacy files read as stable. */
  readonly channel: UpdateChannel;
  readonly checkedAt: string | null;
  readonly latest: string | null;
  /** Null when the manifest came from the plain-text fallback or a legacy cache file. */
  readonly manifest: UpdateManifest | null;
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
    channel: 'stable',
    checkedAt: null,
    latest: null,
    manifest: null,
  };
}

export function emptyUpdateInstallState(): UpdateInstallState {
  return {
    active: null,
    lastFailure: null,
    lastSuccess: null,
  };
}
