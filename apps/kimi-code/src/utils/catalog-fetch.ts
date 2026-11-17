import {
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  loadBuiltInCatalog,
  type Catalog,
  type FetchCatalogOptions,
} from '@moonshot-ai/kimi-code-sdk';

import { BUILT_IN_CATALOG_JSON } from '#/built-in-catalog';

export interface FetchCatalogOrBuiltInResult {
  readonly catalog: Catalog;
  readonly fromBuiltIn: boolean;
}

export interface FetchCatalogOrBuiltInOptions extends FetchCatalogOptions {
  readonly builtInJson?: string;
}

export async function fetchCatalogOrBuiltIn(
  url: string,
  options: FetchCatalogOrBuiltInOptions = {},
): Promise<FetchCatalogOrBuiltInResult> {
  try {
    const catalog = await fetchCatalog(url, options);
    return { catalog, fromBuiltIn: false };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (isAbortError(error)) throw error;
    if (url !== DEFAULT_CATALOG_URL) throw error;
    const builtIn = loadBuiltInCatalog(options.builtInJson ?? BUILT_IN_CATALOG_JSON);
    if (builtIn === undefined) throw error;
    return { catalog: builtIn, fromBuiltIn: true };
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
