import { z } from 'zod';

import {
  fetchClientConfig,
  RESOURCE_CONFIGS_PATH,
  type ClientConfigFetchOptions,
} from '#/utils/client-configs';

/** The tips/banner payload is one named resource on the resource-configs endpoint. */
const CONFIG_NAME = 'client_banner';

/** The payload is a `banner_tips` array (plus per-entry `kfc_audience`),
    which banner-provider parses defensively; the schema only guarantees an
    object. */
const bannerConfigSchema = z.looseObject({});

export type BannerConfig = z.infer<typeof bannerConfigSchema>;
export type BannerConfigFetchOptions = ClientConfigFetchOptions;

/**
 * Fetches the banner config straight from the endpoint — banners are
 * time-sensitive announcements, so no caching layer is used. Any failure
 * resolves to `undefined` — callers treat that as "no banner".
 */
export async function getBannerConfig(
  options: BannerConfigFetchOptions = {},
): Promise<BannerConfig | undefined> {
  return fetchClientConfig(CONFIG_NAME, bannerConfigSchema, {
    ...options,
    path: RESOURCE_CONFIGS_PATH,
  });
}
