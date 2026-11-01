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
  readonly channel: UpdateChannel;
  readonly version: string;
}

export const UPDATE_CHANNELS = ['stable', 'canary'] as const;

/** Release line selected after resolving install source, installed version, and environment. */
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export interface UpdatePointer {
  readonly channel: UpdateChannel;
  readonly latest: string | null;
}

export interface UpdateFeed extends UpdatePointer {
  readonly manifest: UpdateManifest | null;
}

/**
 * The channel resolved once at the env boundary. `default` means the variable
 * is unset or empty; `invalid` keeps the rejected raw value for the warning.
 */
export type ChannelSelection =
  | { readonly channel: UpdateChannel; readonly origin: 'default' }
  | { readonly channel: UpdateChannel; readonly origin: 'env' }
  | { readonly channel: UpdateChannel; readonly origin: 'invalid'; readonly raw: string }
  | { readonly channel: 'stable'; readonly origin: 'homebrew' };

export type UpdatePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'upgrade'; readonly target: UpdateTarget }
  | {
      readonly kind: 'switch-channel';
      readonly sourceChannel: UpdateChannel;
      readonly target: UpdateTarget;
    };

export type ActionableUpdatePlan = Exclude<UpdatePlan, { readonly kind: 'none' }>;
export type UpgradePlan = Extract<UpdatePlan, { readonly kind: 'upgrade' }>;
export type InstallIntent = ActionableUpdatePlan['kind'];

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

export interface UpdateCache extends UpdateFeed {
  readonly source: 'cdn';
  readonly checkedAt: string | null;
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

export type UpdatePromptAction = 'none' | 'prompt-install' | 'manual-command';
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
