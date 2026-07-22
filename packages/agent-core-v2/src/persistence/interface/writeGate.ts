/**
 * `persistence/interface` — session write-admission gate contract.
 *
 * Defines the per-session `ISessionWriteGate` that fences and tracks physical
 * writes, plus the App-scoped `IWriteGateRegistry` used by storage backends to
 * route a storage scope to its owning session gate. Session scopes without a
 * registered gate fail closed; root and non-session scopes are not gated.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export interface ISessionWriteGate {
  run<T>(write: () => Promise<T>): Promise<T>;
  seal(): void;
  drained(): Promise<void>;
}

export const ISessionWriteGate: ServiceIdentifier<ISessionWriteGate> =
  createDecorator<ISessionWriteGate>('sessionWriteGate');

export const IWriteGateRegistry: ServiceIdentifier<IWriteGateRegistry> =
  createDecorator<IWriteGateRegistry>('writeGateRegistry');

export interface IWriteGateRegistry {
  readonly _serviceBrand: undefined;

  register(sessionScope: string, gate: ISessionWriteGate): IDisposable;
  run<T>(scope: string, write: () => Promise<T>): Promise<T>;
}
