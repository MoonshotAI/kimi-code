import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { WatchChange } from '#human/utils/watch';
import type { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';

export interface ProjectInstructionsSnapshot {
  readonly agentsMd: string | undefined;
  readonly agentsMdWarning: string | undefined;
  readonly agentsMdPaths: readonly string[] | undefined;
}

export interface IProjectInstructionsService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly snapshot: ProjectInstructionsSnapshot;
  readonly onDidChange: Event<readonly WatchChange[]>;
  reload(): Promise<void>;
  sessionProvider(): ISessionInstructionsProvider;
}

export const IProjectInstructionsService: ServiceIdentifier<IProjectInstructionsService> =
  createDecorator<IProjectInstructionsService>('workspaceInstructionsService');
