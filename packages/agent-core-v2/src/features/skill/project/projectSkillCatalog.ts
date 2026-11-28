import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { SkillCatalog } from '#/features/skill/catalog/types';
import type { ISessionSkillCatalogData } from '#/features/skill/session/skillCatalogData';

export interface IProjectSkillCatalog {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly catalog: SkillCatalog;
  readonly onDidChange: Event<string>;
  load(): Promise<void>;
  reload(): Promise<void>;
  reloadSources(ids: readonly string[]): Promise<void>;
  sessionData(): ISessionSkillCatalogData;
}

export const IProjectSkillCatalog: ServiceIdentifier<IProjectSkillCatalog> =
  createDecorator<IProjectSkillCatalog>('workspaceSkillCatalog');
