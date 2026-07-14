/**
 * `permissionRules` domain (L3) — `permission` config-section schema and TOML
 * transforms.
 *
 * Owns the `[permission]` configuration section (the persisted permission
 * rules), including the snake_case ↔ camelCase TOML transforms that reshape the
 * on-disk `deny` / `allow` / `ask` lists and the `tool`/`match` shorthand into
 * the in-memory `rules` array. Self-registered at module load via
 * `registerConfigSection`, so the `config` domain never imports this domain's
 * types.
 */

import { z } from 'zod';

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
});

export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;

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
  return rules.length > 0 ? { rules } : {};
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
});
