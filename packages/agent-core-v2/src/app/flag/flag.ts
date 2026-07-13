/**
 * `flag` domain (L3) — experimental-flag resolution contract.
 *
 * Defines the `IFlagService` used to check whether a flag is enabled, snapshot
 * and explain flag state, and apply config overrides, together with the
 * flag-resolution types (`ExperimentalFeatureState`, `ExperimentalFlagConfig`,
 * `ExperimentalFlagSource`). Owns the `[experimental]` config section, whose
 * keys are flag ids and are preserved verbatim (no snake ↔ camel conversion) by
 * its TOML read/write transforms. App-scoped — one instance shared across the
 * process.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { cloneRecord, isPlainObject, setDefined } from '#/app/config/toml';

import type { FlagId, FlagSurface, IFlagRegistry } from './flagRegistry';

export type ExperimentalFlagMap = Record<string, boolean>;

export type ExperimentalFlagConfig = Partial<Record<FlagId, boolean>>;

export const EXPERIMENTAL_SECTION = 'experimental';

export const ExperimentalConfigSchema = z.record(z.string(), z.boolean());

export type ExperimentalConfig = z.infer<typeof ExperimentalConfigSchema>;

export const experimentalFromToml = (rawSnake: unknown): unknown =>
  isPlainObject(rawSnake) ? cloneRecord(rawSnake) : rawSnake;

export const experimentalToToml = (value: unknown, _rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    setDefined(out, key, entry);
  }
  return out;
};

registerConfigSection(EXPERIMENTAL_SECTION, ExperimentalConfigSchema, {
  fromToml: experimentalFromToml,
  toToml: experimentalToToml,
});

export type ExperimentalFlagSource = 'master-env' | 'env' | 'config' | 'default';

export interface ExperimentalFeatureState {
  readonly id: FlagId;
  readonly title: string;
  readonly description: string;
  readonly surface: FlagSurface;
  readonly env: string;
  readonly defaultEnabled: boolean;
  readonly enabled: boolean;
  readonly source: ExperimentalFlagSource;
  readonly configValue?: boolean;
}

export interface IFlagService {
  readonly _serviceBrand: undefined;

  readonly registry: IFlagRegistry;
  enabled(id: FlagId): boolean;
  snapshot(): ExperimentalFlagMap;
  enabledIds(): readonly FlagId[];
  explain(id: FlagId): ExperimentalFeatureState | undefined;
  explainAll(): readonly ExperimentalFeatureState[];
  setConfigOverrides(overrides: ExperimentalFlagConfig | undefined): void;
}

export const IFlagService: ServiceIdentifier<IFlagService> =
  createDecorator<IFlagService>('flagService');
