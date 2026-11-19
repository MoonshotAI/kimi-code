import { RESOURCE_CONFIGS_PATH, type ClientConfigFetchOptions } from '@moonshot-ai/kimi-code-product/client-configs/node';
import { z } from 'zod';

import { clientConfigs } from '#/utils/client-configs';

const CONFIG_NAME = 'client_banner';

const bannerConfigSchema = z.looseObject({});

export type BannerConfig = z.infer<typeof bannerConfigSchema>;
export type BannerConfigFetchOptions = ClientConfigFetchOptions;

export async function getBannerConfig(
  options: BannerConfigFetchOptions = {},
): Promise<BannerConfig | undefined> {
  return clientConfigs.fetch(CONFIG_NAME, bannerConfigSchema, {
    ...options,
    path: RESOURCE_CONFIGS_PATH,
  });
}
