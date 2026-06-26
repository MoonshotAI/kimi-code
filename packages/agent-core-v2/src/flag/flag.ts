/**
 * `flag` domain (L3) — experimental-flag resolution contract.
 *
 * Defines the `IFlagService` used to check whether a flag is enabled, snapshot
 * and explain flag state, and apply config overrides, together with the
 * flag-resolution types (`ExperimentalFeatureState`, `ExperimentalFlagConfig`,
 * `ExperimentalFlagSource`). Core-scoped — one instance shared across the
 * process.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { FlagId, FlagRegistry, FlagSurface } from './registry';

export type ExperimentalFlagMap = Record<string, boolean>;

export type ExperimentalFlagConfig = Partial<Record<FlagId, boolean>>;

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
  readonly registry: FlagRegistry;
  enabled(id: FlagId): boolean;
  snapshot(): ExperimentalFlagMap;
  enabledIds(): readonly FlagId[];
  explain(id: FlagId): ExperimentalFeatureState | undefined;
  explainAll(): readonly ExperimentalFeatureState[];
  setConfigOverrides(overrides: ExperimentalFlagConfig | undefined): void;
}

export const IFlagService: ServiceIdentifier<IFlagService> =
  createDecorator<IFlagService>('flagService');
