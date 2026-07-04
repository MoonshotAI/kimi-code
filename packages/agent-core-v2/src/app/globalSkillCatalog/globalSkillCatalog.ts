/**
 * `globalSkillCatalog` domain (L5) — global skill catalog contract.
 *
 * `IGlobalSkillCatalog` holds the process-wide skill set: code-defined builtin
 * skills plus user / brand skills discovered from the user's home directories.
 * It is loaded once and shared by every Session catalog. App-scoped.
 */

import { createDecorator } from '#/_base/di/instantiation';

import type { SkillCatalog } from './types';

export interface IGlobalSkillCatalog {
  readonly _serviceBrand: undefined;

  readonly catalog: SkillCatalog;
  load(): Promise<void>;
}

export const IGlobalSkillCatalog = createDecorator<IGlobalSkillCatalog>('globalSkillCatalog');
