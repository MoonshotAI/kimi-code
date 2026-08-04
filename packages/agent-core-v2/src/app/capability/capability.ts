/**
 * `capability` domain (L3) — `ICapabilityService` contract.
 *
 * Manages the built-in product capabilities (`kimi-cu`, `kimi-webbridge`):
 * layered readiness detection and idempotent install orchestration. Entries
 * are hardcoded in a closed registry — install sources are fixed official
 * CDN URLs, never client-supplied.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { CapabilityStatus } from './types';

export interface ICapabilityService {
  readonly _serviceBrand: undefined;

  listCapabilities(): Promise<readonly CapabilityStatus[]>;

  getCapability(id: string): Promise<CapabilityStatus>;

  installCapability(id: string): Promise<CapabilityStatus>;
}

export const ICapabilityService: ServiceIdentifier<ICapabilityService> =
  createDecorator<ICapabilityService>('capabilityService');
