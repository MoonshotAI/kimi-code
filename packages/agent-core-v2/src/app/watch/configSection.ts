import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { WATCH_ENV } from '#human/utils/watch';

export const WATCH_SECTION = 'watch';

export const WatchConfigSchema = z.object({
  enabled: z.boolean().optional(),
});

export type WatchConfig = z.infer<typeof WatchConfigSchema>;

export const watchEnvBindings: EnvBindings<WatchConfig> = envBindings(WatchConfigSchema, {
  enabled: { env: WATCH_ENV, parse: parseBooleanEnv },
});

export const stripWatchEnv = stripEnvBoundFields(watchEnvBindings);

registerConfigSection(WATCH_SECTION, WatchConfigSchema, {
  env: watchEnvBindings,
  stripEnv: stripWatchEnv,
});
