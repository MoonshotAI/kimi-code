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
