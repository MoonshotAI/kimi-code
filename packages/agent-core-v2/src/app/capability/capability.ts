/**
 * `capability` domain (L3) — `ICapabilityService` contract.
 *
 * Manages the built-in product capabilities (`kimi-cu`, `kimi-webbridge`):
 * layered readiness detection and idempotent install orchestration. Entries
 * are hardcoded in a closed registry — install sources are fixed official
 * CDN URLs, never client-supplied. Install progress transitions are published
 * through `onDidChangeInstall` (start / step / settle / error).
 * `describeCapabilities` answers the static registry without running any
 * detection probes.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { CapabilityDescriptor, CapabilityInstallChange, CapabilityStatus } from './types';

export interface ICapabilityService {
  readonly _serviceBrand: undefined;

  readonly onDidChangeInstall: Event<CapabilityInstallChange>;

  describeCapabilities(): readonly CapabilityDescriptor[];

  listCapabilities(): Promise<readonly CapabilityStatus[]>;

  getCapability(id: string): Promise<CapabilityStatus>;

  installCapability(id: string): Promise<CapabilityStatus>;
}

export const ICapabilityService: ServiceIdentifier<ICapabilityService> =
  createDecorator<ICapabilityService>('capabilityService');
