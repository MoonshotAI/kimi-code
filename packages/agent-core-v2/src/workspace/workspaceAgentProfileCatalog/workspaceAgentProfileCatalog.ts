/**
 * `workspaceAgentProfileCatalog` domain (L3) — Workspace-scoped merged
 * agent-profile catalog contract.
 *
 * Defines `IWorkspaceAgentProfileCatalog`, the handler-level owner of
 * agent-profile discovery and merging: at handler materialization it merges
 * the builtin (code-contribution) App catalog with the file-backed sources
 * (user / extra / project / explicit) by priority; afterwards single sources
 * refresh incrementally (fs watch on the project agent dirs, config section
 * changes) — never a full rescan. `sessionData()` projects the merged view
 * into the `ISessionAgentProfileCatalogData` seed every Session scope of
 * this handler receives. Bound at Workspace scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { ISessionAgentProfileCatalogData } from '#/session/sessionAgentProfileCatalog/agentProfileCatalogData';

export interface IWorkspaceAgentProfileCatalog {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChange: Event<string>;
  get(name: string): AgentProfile | undefined;
  getDefault(): AgentProfile;
  list(): readonly AgentProfile[];
  load(): Promise<void>;
  reload(): Promise<void>;
  sessionData(): ISessionAgentProfileCatalogData;
}

export const IWorkspaceAgentProfileCatalog: ServiceIdentifier<IWorkspaceAgentProfileCatalog> =
  createDecorator<IWorkspaceAgentProfileCatalog>('workspaceAgentProfileCatalog');
