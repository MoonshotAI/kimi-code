import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';

import type { Event2 } from './event2';

export interface IEventService {
  readonly _serviceBrand: undefined;

  readonly onDidPublish: Event<Event2<any>>;
  publish(event: Event2<any>): void;
  subscribe(handler: (event: Event2<any>) => void): IDisposable;
}

export const IEventService: ServiceIdentifier<IEventService> =
  createDecorator<IEventService>('eventService');
