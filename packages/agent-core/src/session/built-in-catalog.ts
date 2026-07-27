/**
 * Lazily parses the models.dev snapshot injected into the final CLI bundle.
 * Package builds and source tests have no injected value and return undefined.
 */

import type { Catalog } from '@moonshot-ai/kosong';

declare const __KIMI_CODE_BUILT_IN_CATALOG__: string | undefined;

let catalog: Catalog | undefined | null = null;

export function loadBuiltInCatalog(): Catalog | undefined {
  if (catalog !== null) return catalog;
  if (
    typeof __KIMI_CODE_BUILT_IN_CATALOG__ !== 'string' ||
    __KIMI_CODE_BUILT_IN_CATALOG__.length === 0
  ) {
    catalog = undefined;
    return catalog;
  }
  try {
    catalog = JSON.parse(__KIMI_CODE_BUILT_IN_CATALOG__) as Catalog;
  } catch {
    catalog = undefined;
  }
  return catalog;
}
