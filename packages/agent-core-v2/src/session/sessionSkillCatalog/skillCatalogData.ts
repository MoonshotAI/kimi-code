/**
 * `sessionSkillCatalog` domain — seeded skill-catalog data contract.
 *
 * Defines `ISessionSkillCatalogData`, the pure-data injection contract
 * carrying the workspace's merged skill catalog as a live read view plus the
 * source-keyed change event. The contract carries no IO. Session-scoped.
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
