/**
 * `event` domain — process-wide pub/sub event bus contract.
 *
 * Defines `IEventService`, a minimal event bus used by business domains to
 * broadcast facts (for example session lifecycle changes) to an unknown set
 * of consumers. Every published fact is an `Event2` subclass instance; App
 * events are never durable. Bound at App scope; a single global instance.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';

import type { Event2 } from './event2';

export interface IEventService {
  readonly _serviceBrand: undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly onDidPublish: Event<Event2<any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publish(event: Event2<any>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribe(handler: (event: Event2<any>) => void): IDisposable;
}

export const IEventService: ServiceIdentifier<IEventService> =
  createDecorator<IEventService>('eventService');
