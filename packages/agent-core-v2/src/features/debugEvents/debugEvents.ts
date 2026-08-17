import { createDecorator } from '#/_base/di/instantiation';
import type { LedgerEntryInfo } from '#/_base/lifecycle/ledger';

export interface DebugEventSubscription {
  readonly scopePath: string;
  readonly unit: string;
  readonly uid?: number;
  readonly label: string;
  readonly kind: LedgerEntryInfo['kind'];
}

export interface DebugEventBusSnapshot {
  readonly scopePath: string;
  readonly all: number;
  readonly perType: Record<string, number>;
}

export interface DebugEventSubscriptions {
  readonly subscriptions: DebugEventSubscription[];
  readonly buses: DebugEventBusSnapshot[];
  readonly globalListeners?: number;
}

export interface IDebugEventsService {
  readonly _serviceBrand: undefined;

  subscriptions(): DebugEventSubscriptions;
}

export const IDebugEventsService = createDecorator<IDebugEventsService>('debugEventsService');
