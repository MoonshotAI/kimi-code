/**
 * `flag` domain (L3) — flag-definition registry contract.
 *
 * `IFlagRegistry` is the writable catalog that `IFlagService` reads flag
 * definitions from. Definitions are contributed **decentrally**: each domain
 * calls `registerFlagDefinition` from its own `<domain>Flag.ts` top level, and
 * `FlagRegistryService` drains those contributions when it is instantiated.
 * There is no central catalog to edit by hand. App-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export type FlagSurface = 'core' | 'tui' | 'both';

export type FlagId = string;

export interface FlagDefinitionInput {
  readonly id: FlagId;
  readonly title: string;
  readonly description: string;
  readonly env: string;
  readonly default: boolean;
  readonly surface: FlagSurface;
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
