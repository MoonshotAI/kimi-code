/**
 * `sessionAgentProfileCatalog` domain (L3) — seeded agent-profile-catalog data
 * contract.
 *
 * Defines `ISessionAgentProfileCatalogData`, the pure-data injection contract
 * the Workspace-scope `workspaceAgentProfileCatalog` hands to every Session
 * scope it creates: the workspace's merged profile read view (builtin +
 * file-backed sources) plus the source-keyed change event. The contract
 * carries no IO — discovery, merging and rescanning all live on the workspace
 * side; the Session-scope `ISessionAgentProfileCatalog` business view
 * delegates to this seed and refreshes off `onDidChange`. Seeded into the
 * Session scope by `workspaceHandler` when the session is materialized.
 * Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';

export interface ISessionAgentProfileCatalogData {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChange: Event<string>;
  get(name: string): AgentProfile | undefined;
  getDefault(): AgentProfile;
  list(): readonly AgentProfile[];
}

export const ISessionAgentProfileCatalogData: ServiceIdentifier<ISessionAgentProfileCatalogData> =
  createDecorator<ISessionAgentProfileCatalogData>('sessionAgentProfileCatalogData');

export function sessionAgentProfileCatalogDataSeed(
  data: ISessionAgentProfileCatalogData,
): ScopeSeed {
  return [[ISessionAgentProfileCatalogData as ServiceIdentifier<unknown>, data]];
}
