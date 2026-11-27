import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

import type { IFlagService } from './flag';

export const EXPERIMENTAL_SURFACES = ['tui', 'desktop', 'web'] as const;
export type ExperimentalSurface = (typeof EXPERIMENTAL_SURFACES)[number];
export type FlagSurface = ExperimentalSurface;

export const EXPERIMENTAL_PROFILES = ['cli', 'desktop'] as const;
export type ExperimentalProfile = (typeof EXPERIMENTAL_PROFILES)[number];

export const EXPERIMENTAL_STAGES = ['experimental', 'beta', 'ga'] as const;
export type ExperimentalStage = (typeof EXPERIMENTAL_STAGES)[number];

export const EXPERIMENTAL_EFFECT_TIMINGS = ['immediate', 'next-session', 'restart'] as const;
export type ExperimentalEffectTiming = (typeof EXPERIMENTAL_EFFECT_TIMINGS)[number];

export type FlagId = string;

export interface FlagDefinitionInput {
  readonly id: FlagId;
  readonly title: string;
  readonly description: string;
  readonly env: string;
  readonly stages: Partial<Record<ExperimentalSurface, ExperimentalStage>>;
  readonly effectTiming?: ExperimentalEffectTiming;
  readonly isExposed?: (flags: IFlagService) => boolean;
}

const contributedFlags: FlagDefinitionInput[] = [];

export function registerFlagDefinition(definition: FlagDefinitionInput): void {
  contributedFlags.push(definition);
}

export function getContributedFlags(): readonly FlagDefinitionInput[] {
  return contributedFlags;
}

export interface IFlagRegistry {
  readonly _serviceBrand: undefined;

  register(definition: FlagDefinitionInput): IDisposable;
  get(id: FlagId): FlagDefinitionInput | undefined;
  list(): readonly FlagDefinitionInput[];
}

export const IFlagRegistry: ServiceIdentifier<IFlagRegistry> =
  createDecorator<IFlagRegistry>('flagRegistry');
