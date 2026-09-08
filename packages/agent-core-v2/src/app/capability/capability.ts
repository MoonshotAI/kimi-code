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
