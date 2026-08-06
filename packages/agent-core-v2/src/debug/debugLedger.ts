/**
 * `debug` domain — `IDebugLedgerService`: the unit tree = ledger tree (L5
 * debug surface, plan §5.11).
 *
 * Public contract. `tree()` walks the whole container tree under the App
 * root; every node carries the container's scope path and label, its units
 * (the service registrations joined with the cascade engine's five-state
 * unit snapshots) and its ledger entries verbatim (child ledgers already
 * recurse). Bound at App scope. All payloads are JSON-serializable wire data.
 */

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
