import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Environment } from '#/environment/environment';
import type { EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';
import type { Event, IWaitUntil } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';

export interface IEnvironmentDeclarationService {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<EnvironmentDeclarationSet & IWaitUntil>;
  declarations(workspaceId?: string): Promise<EnvironmentDeclarationSet | undefined>;
  whenReady(workspaceId: string): Promise<void>;
  isDeclared(environmentId: string): boolean;
  trackRegistration(environment: Environment): IDisposable;
  catalog(): Promise<EnvironmentDeclarationSet>;
  attachWorkspace(context: IWorkspaceContext, fs: IHostFileSystem, trust: IWorkspaceTrust): IDisposable;
  isVisible(workspaceId: string, environmentId: string): boolean;
  assertAllowed(workspaceId: string, environmentId: string, project?: boolean): void;
  reportRegistration(environmentId: string, error?: Error): void;
}

export const IEnvironmentDeclarationService: ServiceIdentifier<IEnvironmentDeclarationService> = createDecorator<IEnvironmentDeclarationService>('environmentDeclarationService');
