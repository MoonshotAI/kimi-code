import { z } from 'zod';

import { McpServerConfigSchema, type McpServerConfig } from '#/mcpCore/config-schema';

const OVERRIDE_CONTROL_KEYS = ['enabled', 'deferred', 'enabledTools', 'disabledTools'] as const;

export interface McpServerOverride {
  readonly enabled?: boolean;
  readonly deferred?: boolean;
  readonly enabledTools?: string[];
  readonly disabledTools?: string[];
}

export const McpServerOverrideSchema: z.ZodType<McpServerOverride> = z
  .looseObject({
    enabled: z.boolean().optional(),
    deferred: z.boolean().optional(),
    enabledTools: z.array(z.string()).optional(),
    disabledTools: z.array(z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if ((OVERRIDE_CONTROL_KEYS as readonly string[]).includes(key)) continue;
      ctx.addIssue({
        code: 'unrecognized_keys',
        keys: [key],
        message: `Partial MCP server override may only set ${OVERRIDE_CONTROL_KEYS.join(', ')}; received "${key}"`,
      });
    }
  });

export type McpServerConfigEntry = McpServerConfig | McpServerOverride;

export const McpServerConfigEntrySchema: z.ZodType<McpServerConfigEntry> = z.union([
  McpServerConfigSchema,
  McpServerOverrideSchema,
]);

export function isMcpServerConfig(entry: McpServerConfigEntry): entry is McpServerConfig {
  return 'transport' in entry;
}
