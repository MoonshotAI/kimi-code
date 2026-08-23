import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { SkillContribution } from '#/app/skillCatalog/skillSource';
import type { SkillCatalog, SkillSummary } from '#/app/skillCatalog/types';

export interface ISessionSkillCatalog {
  readonly _serviceBrand: undefined;

  readonly catalog: SkillCatalog;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<string>;
  load(): Promise<void>;
  reload(): Promise<void>;
  /**
   * Wire-friendly snapshot of the merged catalog: every skill as a
   * `SkillSummary`, resolved after `ready`. Unlike the `catalog` property
   * (a live object whose methods do not cross a wire), the result is plain
   * serializable data.
   */
  list(): Promise<readonly SkillSummary[]>;
}

export interface ISkillCatalogSink {
  readonly _serviceBrand: undefined;

  set(id: string, contribution: SkillContribution, options: { readonly priority: number }): void;
  remove(id: string): void;
}

export const ISessionSkillCatalog = createDecorator<ISessionSkillCatalog>('sessionSkillCatalog');
