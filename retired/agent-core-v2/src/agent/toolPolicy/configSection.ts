/**
 * `toolPolicy` domain (L4) — the global `tools` tool-activation section.
 *
 * The `tools` section is the global tool switch: `enabled` is an allowlist
 * (when non-empty, only listed tools are active) and `disabled` a denylist,
 * applied on top of every profile's own `tools` / `disallowedTools` policy by
 * `IAgentToolPolicyService`.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const TOOLS_SECTION = 'tools';

export const ToolsConfigSchema = z.object({
  enabled: z.array(z.string()).optional(),
  disabled: z.array(z.string()).optional(),
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

registerConfigSection(TOOLS_SECTION, ToolsConfigSchema);
