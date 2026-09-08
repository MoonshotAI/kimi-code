import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import {
  cloneRecord,
  isPlainObject,
  plainObjectToToml,
  transformPlainObject,
} from '#/app/config/toml';

import { parsePermissionPattern } from './matchesRule';

export const PERMISSION_SECTION = 'permission';

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

export const permissionEnvBindings: EnvBindings<PermissionConfig> = envBindings(
  PermissionConfigSchema,
  {
    dangerousCommandGuard: {
      env: DANGEROUS_COMMAND_GUARD_ENV,
      parse: parseDangerousCommandGuardEnv,
    },
  },
);

export const stripPermissionEnv = stripEnvBoundFields(permissionEnvBindings);

export function isDangerousCommandGuardEnabled(config: IConfigService): boolean {
  return (
    config.get<PermissionConfig | undefined>(PERMISSION_SECTION)?.dangerousCommandGuard ?? true
  );
}

function isValidPermissionPattern(pattern: string): boolean {
  try {
    parsePermissionPattern(pattern);
    return true;
  } catch {
    return false;
  }
}

export const permissionFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const raw = transformPlainObject(rawSnake);
  const rules: unknown[] = [];
  appendPermissionRules(rules, raw['rules']);
  appendPermissionRules(rules, raw['deny'], 'deny');
  appendPermissionRules(rules, raw['allow'], 'allow');
  appendPermissionRules(rules, raw['ask'], 'ask');
  const out: Record<string, unknown> = {};
  if (rules.length > 0) out['rules'] = rules;
  if (raw['dangerousCommandGuard'] !== undefined) {
    out['dangerousCommandGuard'] = raw['dangerousCommandGuard'];
  }
  return out;
};

function appendPermissionRules(
  target: unknown[],
  value: unknown,
  decision?: 'allow' | 'deny' | 'ask',
): void {
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    target.push(transformPermissionRule(entry, decision));
  }
}

function transformPermissionRule(value: unknown, decision?: 'allow' | 'deny' | 'ask'): unknown {
  if (!isPlainObject(value)) return value;
  const rule = transformPlainObject(value);
  const tool = rule['tool'];
  const match = rule['match'];
  const pattern = rule['pattern'];
  const out: Record<string, unknown> = {
    decision: decision !== undefined ? decision : rule['decision'],
    scope: rule['scope'],
    reason: rule['reason'],
  };
  if (typeof tool === 'string') {
    const argPattern = typeof match === 'string' ? match : pattern;
    out['pattern'] = typeof argPattern === 'string' ? `${tool}(${argPattern})` : tool;
  } else {
    out['pattern'] = pattern;
  }
  return out;
}

export const permissionToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const out = cloneRecord(rawSnake);
  delete out['deny'];
  delete out['allow'];
  delete out['ask'];
  const rules = value['rules'];
  if (Array.isArray(rules)) {
    out['rules'] = rules.map((rule) =>
      isPlainObject(rule) ? plainObjectToToml(rule, undefined) : rule,
    );
  } else {
    delete out['rules'];
  }
  return out;
};

registerConfigSection(PERMISSION_SECTION, PermissionConfigSchema, {
  fromToml: permissionFromToml,
  toToml: permissionToToml,
  env: permissionEnvBindings,
  stripEnv: stripPermissionEnv,
});
