/**
 * `sessionPluginContribution` domain (L3) — Session-scoped plugin-contribution
 * convergence contract.
 *
 * Defines `ISessionPluginContributionService`, the Session-level convergence
 * point for App-scope plugin changes, and the awaitable `onDidChange` event
 * that Agent consumers join with their own refresh work. Each completed
 * convergence advances `generation`, so an Agent created mid-convergence can
 * tell after `settled()` whether it must catch up — a plugin mutation never
 * straddles an Agent's bootstrap. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';

export type SessionPluginContributionChangedEvent = IWaitUntil;

export const PLUGIN_CONVERGENCE_TIMEOUT_MS = 30_000;

export interface ISessionPluginContributionService {
  readonly _serviceBrand: undefined;

  readonly onDidChange: Event<SessionPluginContributionChangedEvent>;
  generation(): number;
  settled(): Promise<void>;
}

export const ISessionPluginContributionService: ServiceIdentifier<ISessionPluginContributionService> =
  createDecorator<ISessionPluginContributionService>('sessionPluginContributionService');
