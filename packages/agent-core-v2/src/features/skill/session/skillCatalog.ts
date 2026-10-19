import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { SkillContribution } from '#/features/skill/catalog/skillSource';
import type { SkillCatalog, SkillSummary } from '#/features/skill/catalog/types';

export interface ISessionSkillCatalog {
  readonly _serviceBrand: undefined;

  readonly catalog: SkillCatalog;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<string>;
  load(): Promise<void>;
  reload(): Promise<void>;
  list(): Promise<readonly SkillSummary[]>;
}

export interface ISkillCatalogSink {
  readonly _serviceBrand: undefined;

  set(id: string, contribution: SkillContribution, options: { readonly priority: number }): void;
  remove(id: string): void;
}

export const ISessionSkillCatalog = createDecorator<ISessionSkillCatalog>('sessionSkillCatalog');
