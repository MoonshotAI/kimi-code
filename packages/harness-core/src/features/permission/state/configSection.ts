import { z } from 'zod';

import type { ConfigSectionContribution } from '@moonshot-ai/agent-core';

import { parsePermissionPattern } from '../language/pattern';
import type { PermissionRule } from '../types';

export const PERMISSION_CONFIG_SECTION = 'permission';

export const PermissionRuleDecisionSchema = z.enum(['allow', 'deny', 'ask']);
export const PermissionRuleScopeSchema = z.enum([
  'turn-override',
  'session-runtime',
  'project',
  'user',
]);

export const PermissionRuleSchema = z.object({
  decision: PermissionRuleDecisionSchema,
  scope: PermissionRuleScopeSchema.default('user'),
  pattern: z.string().min(1).refine(isValidPermissionPattern, {
    message: 'Invalid permission rule pattern',
  }),
  reason: z.string().optional(),
});

export const PermissionConfigSchema = z.object({
  rules: z.array(PermissionRuleSchema).optional(),
  dangerousCommandGuard: z.boolean().optional(),
});

export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;

export const DANGEROUS_COMMAND_GUARD_ENV = 'KIMI_CODE_DANGEROUS_COMMAND_GUARD';

function parseDangerousCommandGuardEnv(raw: string): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

function isValidPermissionPattern(pattern: string): boolean {
  try {
    parsePermissionPattern(pattern);
    return true;
  } catch {
    return false;
  }
}

export function configRules(config: PermissionConfig | undefined): readonly PermissionRule[] {
  return config?.rules ?? [];
}

export function isDangerousCommandGuardEnabled(config: PermissionConfig | undefined): boolean {
  return config?.dangerousCommandGuard ?? true;
}

export const permissionConfigSection: ConfigSectionContribution<PermissionConfig> = {
  name: PERMISSION_CONFIG_SECTION,
  schema: PermissionConfigSchema,
  defaultValue: {},
  envBindings: {
    dangerousCommandGuard: {
      env: DANGEROUS_COMMAND_GUARD_ENV,
      parse: parseDangerousCommandGuardEnv,
    },
  },
  stripEnv: (value) => {
    const out = { ...value };
    delete out.dangerousCommandGuard;
    return out;
  },
};
