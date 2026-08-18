import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';

export interface IUserAgentProfileLoader {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  getDefaultProfile(): AgentProfile;
  reload(): Promise<void>;
}

export const IUserAgentProfileLoader: ServiceIdentifier<IUserAgentProfileLoader> =
  createDecorator<IUserAgentProfileLoader>('userAgentProfileLoader');
