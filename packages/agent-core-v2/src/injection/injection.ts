/**
 * `injection` domain (L4) — agent injection service + per-turn queue.
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
