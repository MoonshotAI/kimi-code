import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Environment, EnvironmentBinding } from '#/environment/environment';
import type { EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';

export interface IEnvironmentDeclarationService {
  readonly _serviceBrand: undefined;
  declarations(): Promise<EnvironmentDeclarationSet | undefined>;
  declaredDefaultCwd(environmentId: string): Promise<string | undefined>;
  ensureConnected(environmentId: string): Promise<Environment | undefined>;
  assertCwdUsable(environmentId: string, cwd: string): Promise<void>;
  readPersistedEnvironmentBinding(workspaceId: string, sessionId: string): Promise<EnvironmentBinding | undefined>;
}

export const IEnvironmentDeclarationService: ServiceIdentifier<IEnvironmentDeclarationService> = createDecorator<IEnvironmentDeclarationService>('environmentDeclarationService');
