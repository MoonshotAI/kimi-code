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
  /** True when the network fetch failed and the release-build snapshot was used. */
  readonly fromBuiltIn: boolean;
}

export interface FetchCatalogOrBuiltInOptions extends FetchCatalogOptions {
  /**
   * Override the built-in snapshot JSON (tests). Defaults to the tsdown-injected
   * `__KIMI_CODE_BUILT_IN_CATALOG__` constant.
   */
  readonly builtInJson?: string;
}

/**
 * Fetches a models.dev-style catalog, falling back to the release-build
 * snapshot when the public default URL is unreachable.
 *
 * Custom `--url` overrides never fall back — a private registry must fail
 * loudly rather than silently substitute models.dev. User abort
 * (`signal.aborted`) also skips the fallback so Cancel stays Cancel.
 */
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
