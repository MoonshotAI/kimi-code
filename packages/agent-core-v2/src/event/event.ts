/**
 * `event` domain (L7) — core-scope global pub-sub.
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
