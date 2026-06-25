/**
 * `injection` domain (L4) — agent injection service and per-turn queue.
 *
 * Defines the public contract for injections: the `InjectionItem` model, the
 * `IInjectionService` used by an agent to queue and flush pending injections,
 * and the `IInjectionQueue` for per-turn injection buffering. `IInjectionService`
 * is Agent-scoped (one per agent); `IInjectionQueue` is Turn-scoped (one per
 * turn).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface InjectionItem {
  readonly kind: string;
  readonly content: string;
}

export interface IInjectionService {
  readonly _serviceBrand: undefined;
  push(item: InjectionItem): void;
  flush(): readonly InjectionItem[];
}

export const IInjectionService: ServiceIdentifier<IInjectionService> =
  createDecorator<IInjectionService>('injectionService');

export interface IInjectionQueue {
  readonly _serviceBrand: undefined;
  push(item: InjectionItem): void;
  flush(): readonly InjectionItem[];
}

export const IInjectionQueue: ServiceIdentifier<IInjectionQueue> =
  createDecorator<IInjectionQueue>('injectionQueue');
