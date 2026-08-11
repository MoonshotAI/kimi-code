/**
 * `workspaceInstructions` domain — Workspace-scoped AGENTS.md service
 * contract.
 *
 * Defines `IWorkspaceInstructionsService`, the handler-level owner of the
 * workspace's AGENTS.md instruction snapshot: loaded once at handler
 * materialization through the `profile` domain's pure loader, then
 * invalidated by fs watch on every candidate instruction file and reloaded
 * debounced. `sessionProvider()` projects the snapshot into the
 * `ISessionInstructionsProvider` seed every Session scope of this handler
 * receives, so agent system prompts read the shared snapshot and refresh off
 * its change event instead of re-reading the files per prompt build. Bound
 * at Workspace scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
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
  readonly onDidChange: Event<void>;
  reload(): Promise<void>;
  sessionProvider(): ISessionInstructionsProvider;
}

export const IWorkspaceInstructionsService: ServiceIdentifier<IWorkspaceInstructionsService> =
  createDecorator<IWorkspaceInstructionsService>('workspaceInstructionsService');
