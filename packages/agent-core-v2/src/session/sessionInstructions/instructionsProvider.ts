/**
 * `sessionInstructions` domain — seeded AGENTS.md provider contract.
 *
 * Defines `ISessionInstructionsProvider`, the pure-data injection contract
 * carrying the workspace's current AGENTS.md snapshot (combined content plus
 * the oversize/load warning) and the change event fired when a watched
 * instruction file invalidates the snapshot. The contract carries no IO.
 * Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Event } from '#/_base/event';

export interface ISessionInstructionsProvider {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly agentsMd: string | undefined;
  readonly agentsMdWarning: string | undefined;
  readonly onDidChange: Event<void>;
}

export const ISessionInstructionsProvider: ServiceIdentifier<ISessionInstructionsProvider> =
  createDecorator<ISessionInstructionsProvider>('sessionInstructionsProvider');

export function sessionInstructionsProviderSeed(
  provider: ISessionInstructionsProvider,
): ScopeSeed {
  return [[ISessionInstructionsProvider as ServiceIdentifier<unknown>, provider]];
}
