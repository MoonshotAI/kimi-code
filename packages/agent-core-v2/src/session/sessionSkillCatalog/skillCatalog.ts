/**
 * `sessionSkillCatalog` domain (L3) — session skill catalog sink contract.
 *
 * `ISessionSkillCatalog` is the read view of one session's active skill set:
 * the ordered, keyed merge of every `ISkillSource` (builtin / user / workspace
 * / plugin) folded into the sink by priority. `ready` resolves once the four
 * eager sources have each completed their first `load()`+merge; `onDidChange`
 * fires after every merge. `ISkillCatalogSink` is the push side for ad-hoc
 * (e.g. server) sources to `set`/`remove` a contribution. Session-scoped.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { SkillContribution } from '#/app/skillCatalog/skillSource';
import type { SkillCatalog } from '#/app/skillCatalog/types';

export interface ISessionSkillCatalog {
  readonly _serviceBrand: undefined;

  readonly catalog: SkillCatalog;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<void>;
  load(): Promise<void>;
  reload(): Promise<void>;
}

export interface ISkillCatalogSink {
  readonly _serviceBrand: undefined;

  set(id: string, contribution: SkillContribution, options: { readonly priority: number }): void;
  remove(id: string): void;
}

export const ISessionSkillCatalog = createDecorator<ISessionSkillCatalog>('sessionSkillCatalog');
