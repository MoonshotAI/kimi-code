import type { UnitState } from '#/_base/di/cascadeEngine';
import { createDecorator } from '#/_base/di/instantiation';
import type { LedgerEntryInfo } from '#/_base/lifecycle/ledger';

export interface DebugUnit {
  readonly token: string;
  readonly uid: number;
  readonly state?: UnitState;
  readonly error?: string;
  readonly everActive?: boolean;
  readonly inFlight?: boolean;
}

export interface DebugLedgerNode {
  readonly path: string;
  readonly label: string;
  readonly units: DebugUnit[];
  readonly ledger: LedgerEntryInfo[];
  readonly children: DebugLedgerNode[];
}

export interface IDebugLedgerService {
  readonly _serviceBrand: undefined;

  tree(): DebugLedgerNode;
}

export const IDebugLedgerService =
  createDecorator<IDebugLedgerService>('debugLedgerService');
