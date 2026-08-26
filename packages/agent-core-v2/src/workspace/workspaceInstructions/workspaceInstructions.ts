import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { HostFsChange } from '#/os/interface/hostFsWatch';
import type { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';

export interface WorkspaceInstructionsSnapshot {
  readonly agentsMd: string | undefined;
  readonly agentsMdWarning: string | undefined;
  readonly agentsMdPaths: readonly string[] | undefined;
}

export interface IWorkspaceInstructionsService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly snapshot: WorkspaceInstructionsSnapshot;
  readonly onDidChange: Event<readonly HostFsChange[]>;
  reload(): Promise<void>;
  sessionProvider(): ISessionInstructionsProvider;
}

export const IWorkspaceInstructionsService: ServiceIdentifier<IWorkspaceInstructionsService> =
  createDecorator<IWorkspaceInstructionsService>('workspaceInstructionsService');
