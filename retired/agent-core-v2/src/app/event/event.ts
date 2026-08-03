/**
 * `event` domain (L0) — process-wide pub/sub event bus contract.
 *
 * Defines `IEventService`, a minimal type-tagged event bus used by business
 * domains to broadcast facts (for example session lifecycle changes) to an
 * unknown set of consumers. Bound at App scope; a single global instance.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';

export interface DomainEvent {
  readonly type: string;
  readonly payload: unknown;
}

export interface IEventService {
  readonly _serviceBrand: undefined;

  readonly onDidPublish: Event<DomainEvent>;
  publish(event: DomainEvent): void;
  subscribe(handler: (event: DomainEvent) => void): IDisposable;
}

export const IEventService: ServiceIdentifier<IEventService> =
  createDecorator<IEventService>('eventService');
