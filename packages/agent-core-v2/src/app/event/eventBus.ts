import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';

import type { Event2, Event2Class } from './event2';

export interface IEventBus {
  readonly _serviceBrand: undefined;

  publish(event: Event2<any>): void;
  subscribe(handler: (event: Event2<any>) => void): IDisposable;
  subscribe<P, E extends Event2<P>>(cls: Event2Class<P, E>, handler: (event: E) => void): IDisposable;
  subscribe(type: string, handler: (event: Event2<any>) => void): IDisposable;
}

export const IEventBus: ServiceIdentifier<IEventBus> = createDecorator<IEventBus>('eventBus');
