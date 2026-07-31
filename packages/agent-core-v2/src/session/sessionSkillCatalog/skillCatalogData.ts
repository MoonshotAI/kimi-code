/**
 * `sessionSkillCatalog` domain (L3) — seeded skill-catalog data contract.
 *
 * Defines `ISessionSkillCatalogData`, the pure-data injection contract the
 * Workspace-scope `workspaceSkillCatalog` hands to every Session scope it
 * creates: the workspace's merged skill catalog as a live read view plus the
 * source-keyed change event. The contract carries no IO — discovery, merging
 * and rescanning all live on the workspace side; the Session-scope
 * `ISessionSkillCatalog` business view reads this seed and refreshes itself
 * off `onDidChange`. Seeded into the Session scope by `workspaceHandler` when
 * the session is materialized. Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Event } from '#/_base/event';

import type { SkillCatalog } from '#/app/skillCatalog/types';

export interface ISessionSkillCatalogData {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly catalog: SkillCatalog;
  readonly onDidChange: Event<string>;
}

export const ISessionSkillCatalogData: ServiceIdentifier<ISessionSkillCatalogData> =
  createDecorator<ISessionSkillCatalogData>('sessionSkillCatalogData');

export function sessionSkillCatalogDataSeed(data: ISessionSkillCatalogData): ScopeSeed {
  return [[ISessionSkillCatalogData as ServiceIdentifier<unknown>, data]];
}
