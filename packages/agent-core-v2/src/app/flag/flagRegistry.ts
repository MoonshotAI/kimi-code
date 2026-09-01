import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

import type { IFlagService } from './flag';

export type FlagSurface = 'core' | 'tui' | 'both';

export type FlagId = string;

export interface FlagDefinitionInput {
  readonly id: FlagId;
  readonly title: string;
  readonly description: string;
  readonly env: string;
  readonly default: boolean;
  readonly surface: FlagSurface;
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
