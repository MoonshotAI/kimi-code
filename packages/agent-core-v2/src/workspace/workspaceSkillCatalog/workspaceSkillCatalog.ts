/**
 * `workspaceSkillCatalog` domain — Workspace-scoped skill catalog
 * contract.
 *
 * Defines `IWorkspaceSkillCatalog`, the handler-level owner of skill
 * discovery and merging: at handler materialization it loads every source
 * (builtin / user / explicit / extra / workspace-root / plugin) and merges by
 * priority; afterwards single sources refresh incrementally (fs watch on the
 * project skill dirs, config section changes, plugin reloads) — never a full
 * rescan. `sessionData()` projects the merged view into the
 * `ISessionSkillCatalogData` seed every Session scope of this handler
 * receives. Bound at Workspace scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { SkillCatalog } from '#/app/skillCatalog/types';
import type { ISessionSkillCatalogData } from '#/session/sessionSkillCatalog/skillCatalogData';

export interface IWorkspaceSkillCatalog {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly catalog: SkillCatalog;
  readonly onDidChange: Event<string>;
  load(): Promise<void>;
  reload(): Promise<void>;
  reloadSources(ids: readonly string[]): Promise<void>;
  sessionData(): ISessionSkillCatalogData;
}

export const IWorkspaceSkillCatalog: ServiceIdentifier<IWorkspaceSkillCatalog> =
  createDecorator<IWorkspaceSkillCatalog>('workspaceSkillCatalog');
