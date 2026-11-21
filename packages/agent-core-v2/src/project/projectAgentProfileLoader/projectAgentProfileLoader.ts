import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IProjectAgentProfileLoader {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  reload(): Promise<void>;
}

export const IProjectAgentProfileLoader: ServiceIdentifier<IProjectAgentProfileLoader> =
  createDecorator<IProjectAgentProfileLoader>('workspaceAgentProfileLoader');
