/**
 * `sessionPluginContribution` domain (L3) — Session-scoped plugin-contribution
 * convergence contract.
 *
 * Defines `ISessionPluginContributionService`, the Session-level convergence
 * point for App-scope plugin changes, and the awaitable `onDidChange` event
 * that Agent consumers join with their own refresh work. Bound at Session
 * scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';

export type SessionPluginContributionChangedEvent = IWaitUntil;

export interface ISessionPluginContributionService {
  readonly _serviceBrand: undefined;

  readonly onDidChange: Event<SessionPluginContributionChangedEvent>;
}

export const ISessionPluginContributionService: ServiceIdentifier<ISessionPluginContributionService> =
  createDecorator<ISessionPluginContributionService>('sessionPluginContributionService');
