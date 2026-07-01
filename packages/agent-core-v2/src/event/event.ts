/**
 * `event` domain (L7) — core-scope global pub-sub.
 *
 * Defines the public contract of the event bus: the `ProtocolEvent` model and
 * the `IEventService` used by other domains to publish and subscribe to
 * protocol events. Core-scoped — one shared bus for the application.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export interface ProtocolEvent {
  readonly type: string;
  readonly payload: unknown;
}

export interface IEventService {
  readonly _serviceBrand: undefined;
  publish(event: ProtocolEvent): void;
  subscribe(handler: (event: ProtocolEvent) => void): IDisposable;
}

export const IEventService: ServiceIdentifier<IEventService> =
  createDecorator<IEventService>('eventService');
