import { join } from 'node:path';

import { ClientConfigClient } from '@moonshot-ai/kimi-code-product/client-configs/node';

import { getCacheDir } from '#/utils/paths';
import { currentKimiRegion } from '#/utils/region';

export const clientConfigs = new ClientConfigClient({
  region: currentKimiRegion,
  baseUrlOverride: () => process.env['KIMI_CODE_BASE_URL'],
  cacheDir: () => join(getCacheDir(), 'client-configs'),
});
