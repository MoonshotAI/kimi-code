/**
 * `sessionSkillCatalog` domain (L3) — Session-scoped skill catalog contract.
 *
 * Defines the merged session read view, source-specific change events, and the
 * sink used by ad-hoc skill contributors. Bound at Session scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { SkillContribution } from '#/app/skillCatalog/skillSource';
import type { SkillCatalog } from '#/app/skillCatalog/types';

export interface ISessionSkillCatalog {
  readonly _serviceBrand: undefined;

  readonly catalog: SkillCatalog;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<string>;
  load(): Promise<void>;
  reload(): Promise<void>;
  /**
   * Wait until the catalog has finished its initial load and every in-flight
   * source reload (including ones started while awaiting) has merged. Route
   * handlers that list skills must call this instead of only `ready`, so a
   * config-driven source refresh cannot race the response with a stale view.
   */
  awaitPendingReloads(): Promise<void>;
}

export interface ISkillCatalogSink {
  readonly _serviceBrand: undefined;

  set(id: string, contribution: SkillContribution, options: { readonly priority: number }): void;
  remove(id: string): void;
}

export const ISessionSkillCatalog = createDecorator<ISessionSkillCatalog>('sessionSkillCatalog');
