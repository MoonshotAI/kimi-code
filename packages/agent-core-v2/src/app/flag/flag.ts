import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { cloneRecord, isPlainObject, setDefined } from '#/app/config/toml';

import {
  EXPERIMENTAL_PROFILES,
  type ExperimentalEffectTiming,
  type ExperimentalProfile,
  type ExperimentalStage,
  type FlagId,
  type IFlagRegistry,
} from './flagRegistry';

export type ExperimentalFlagMap = Record<string, boolean>;

export type ExperimentalFlagConfig = Partial<Record<FlagId, boolean>>;

export const EXPERIMENTAL_SECTION = 'experimental';
export const BETA_MASTER_CONFIG_KEY = 'beta';
export const LEGACY_CLI_ONLY_EXPERIMENTAL_KEYS: ReadonlySet<string> = new Set([
  'notify_user',
  'wait_for',
]);

export const ExperimentalBucketSchema = z.record(z.string(), z.boolean());

export type ExperimentalBucketConfig = z.infer<typeof ExperimentalBucketSchema>;

export const ExperimentalConfigSchema = z
  .object({
    cli: ExperimentalBucketSchema.optional(),
    desktop: ExperimentalBucketSchema.optional(),
  })
  .strict();

export type ExperimentalConfig = z.infer<typeof ExperimentalConfigSchema>;

const EXPERIMENTAL_PROFILE_SET: ReadonlySet<string> = new Set(EXPERIMENTAL_PROFILES);

export const experimentalFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;

  const out: Record<string, unknown> = {};
  for (const profile of EXPERIMENTAL_PROFILES) {
    const rawBucket = rawSnake[profile];
    if (rawBucket !== undefined) {
      out[profile] = isPlainObject(rawBucket) ? cloneRecord(rawBucket) : rawBucket;
    }
  }

  for (const [key, value] of Object.entries(rawSnake)) {
    if (EXPERIMENTAL_PROFILE_SET.has(key)) continue;
    if (typeof value !== 'boolean') {
      out[key] = value;
      continue;
    }
    const targetProfiles: readonly ExperimentalProfile[] = LEGACY_CLI_ONLY_EXPERIMENTAL_KEYS.has(
      key,
    )
      ? ['cli']
      : EXPERIMENTAL_PROFILES;
    for (const profile of targetProfiles) {
      const existing = out[profile];
      if (existing === undefined) {
        out[profile] = { [key]: value };
      } else if (isPlainObject(existing) && !Object.hasOwn(existing, key)) {
        existing[key] = value;
      }
    }
  }

  return out;
};

export const experimentalToToml = (value: unknown, _rawSnake?: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (EXPERIMENTAL_PROFILE_SET.has(key) && isPlainObject(entry)) {
      const bucket: Record<string, unknown> = {};
      for (const [flagKey, flagValue] of Object.entries(entry)) {
        setDefined(bucket, flagKey, flagValue);
      }
      if (Object.keys(bucket).length > 0) {
        out[key] = bucket;
      }
      continue;
    }
    setDefined(out, key, entry);
  }
  return out;
};

registerConfigSection(EXPERIMENTAL_SECTION, ExperimentalConfigSchema, {
  fromToml: experimentalFromToml,
  toToml: experimentalToToml,
});

export type BetaMasterSwitchSource = 'env' | 'config' | 'default';

export interface BetaMasterSwitchState {
  readonly profile: ExperimentalProfile;
  readonly enabled: boolean;
  readonly source: BetaMasterSwitchSource;
  readonly env: string;
  readonly configValue?: boolean;
}

export type ExperimentalFlagSource =
  | 'env'
  | 'master-env'
  | 'beta-config'
  | 'config'
  | 'default';

export interface ExperimentalFeatureState {
  readonly id: FlagId;
  readonly title: string;
  readonly description: string;
  readonly stage: ExperimentalStage;
  readonly effectTiming: ExperimentalEffectTiming;
  readonly env: string;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly source: ExperimentalFlagSource;
  readonly configValue?: boolean;
}

export interface IFlagService {
  readonly _serviceBrand: undefined;

  readonly registry: IFlagRegistry;
  readonly profile: ExperimentalProfile;
  readonly onDidChangeFlags: Event<void>;
  betaState(): BetaMasterSwitchState;
  enabled(id: FlagId): boolean;
  snapshot(): ExperimentalFlagMap;
  enabledIds(): readonly FlagId[];
  exposedIds(): readonly FlagId[];
  explain(id: FlagId): ExperimentalFeatureState | undefined;
  explainAll(): readonly ExperimentalFeatureState[];
  setConfigOverrides(overrides: ExperimentalFlagConfig | undefined): void;
}

export const IFlagService: ServiceIdentifier<IFlagService> =
  createDecorator<IFlagService>('flagService');
