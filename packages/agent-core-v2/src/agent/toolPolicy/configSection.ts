import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const TOOLS_SECTION = 'tools';

export const ToolsConfigSchema = z.object({
  enabled: z.array(z.string()).optional(),
  disabled: z.array(z.string()).optional(),
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

export const TOOLS_DISABLED_ENV = 'KIMI_CODE_TOOLS_DISABLED';

function parseToolsDisabledEnv(raw: string): string[] | undefined {
  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return names.length > 0 ? names : undefined;
}

export const toolsEnvBindings: EnvBindings<ToolsConfig> = envBindings(ToolsConfigSchema, {
  disabled: { env: TOOLS_DISABLED_ENV, parse: parseToolsDisabledEnv },
});

export const stripToolsEnv = stripEnvBoundFields(toolsEnvBindings);

registerConfigSection(TOOLS_SECTION, ToolsConfigSchema, {
  env: toolsEnvBindings,
  stripEnv: stripToolsEnv,
});
