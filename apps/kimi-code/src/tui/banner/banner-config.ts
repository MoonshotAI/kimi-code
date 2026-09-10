import { z } from 'zod';

import { fetchClientConfig, type ClientConfigFetchOptions } from '#/utils/client-configs';

/** The tips/banner payload is one named config on the client-configs endpoint. */
const CONFIG_NAME = 'client_banner';

/** The payload keeps the legacy tips.json shape, which banner-provider parses
    defensively; the schema only guarantees an object. */
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
  return fetchClientConfig(CONFIG_NAME, bannerConfigSchema, options);
}
