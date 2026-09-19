import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Environment, EnvironmentBinding } from '#/environment/environment';
import type { EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';

export interface IEnvironmentDeclarationService {
  readonly _serviceBrand: undefined;
  declarations(root: string): Promise<EnvironmentDeclarationSet | undefined>;
  declaredDefaultCwd(root: string, environmentId: string): Promise<string | undefined>;
  ensureConnected(workspaceId: string, environmentId: string): Promise<Environment | undefined>;
  assertCwdUsable(workspaceId: string, environmentId: string, cwd: string): Promise<void>;
  readPersistedEnvironmentBinding(workspaceId: string, sessionId: string): Promise<EnvironmentBinding | undefined>;
}

export const IEnvironmentDeclarationService: ServiceIdentifier<IEnvironmentDeclarationService> = createDecorator<IEnvironmentDeclarationService>('environmentDeclarationService');
