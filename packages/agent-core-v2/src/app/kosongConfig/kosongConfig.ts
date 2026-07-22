/**
 * `kosongConfig` domain (L3) — the kosong persistence bridge contract.
 *
 * `IKosongConfigService` is the two-way sync between the config service
 * (persistence) and kosong's in-memory provider/model registries:
 *
 *  - **Startup / config → kosong**: once config is ready, the registries are
 *    hydrated from the effective config view; later config section changes
 *    (TOML edits, `config.reload`, direct `config.set/replace` writes such as
 *    the OAuth flows) are pushed into kosong the same way.
 *  - **kosong → config**: mutations that land in kosong (klient `addProvider`,
 *    discovery refresh results, default-pointer changes) fire kosong change
 *    events, which the bridge persists back through `config.replace`.
 *
 * Kosong itself never sees the config service — this bridge is the only
 * component that knows both sides. Bound at App scope; instantiated by the
 * composition root (`bootstrap`) so hydration is guaranteed before any
 * consumer can await the kosong registries' `ready`.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IKosongConfigService {
  readonly _serviceBrand: undefined;

  /** Resolves once the initial config → kosong hydration has completed. */
  readonly ready: Promise<void>;
}

export const IKosongConfigService: ServiceIdentifier<IKosongConfigService> =
  createDecorator<IKosongConfigService>('kosongConfigService');
