import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Environment, EnvironmentBinding } from '#/environment/environment';
import type { EnvironmentDeclarationSet, RemoteEnvironmentEntry } from '#/environment/remoteEnvironmentDeclaration';

export interface DeclareEnvironmentInput {
  readonly workspaceId: string;
  readonly id: string;
  readonly entry: RemoteEnvironmentEntry;
  readonly scope?: 'global' | 'project';
}

export interface IEnvironmentDeclarationService {
  readonly _serviceBrand: undefined;
  declare(input: DeclareEnvironmentInput): Promise<void>;
  registerReconciler(workspaceId: string, reconcile: () => Promise<void>): IDisposable;
  declarations(root: string): Promise<EnvironmentDeclarationSet | undefined>;
  declaredDefaultCwd(root: string, environmentId: string): Promise<string | undefined>;
  ensureConnected(workspaceId: string, environmentId: string): Promise<Environment | undefined>;
  assertCwdUsable(workspaceId: string, environmentId: string, cwd: string): Promise<void>;
  readPersistedEnvironmentBinding(workspaceId: string, sessionId: string): Promise<EnvironmentBinding | undefined>;
}

export const IEnvironmentDeclarationService: ServiceIdentifier<IEnvironmentDeclarationService> = createDecorator<IEnvironmentDeclarationService>('environmentDeclarationService');
