import { KIMI_REGION_PROFILES, type KimiRegion } from '@moonshot-ai/kimi-code-oauth';
import { z } from 'zod';

const CLIENT_CONFIGS_PATH = '/client_configs';
const FETCH_TIMEOUT_MS = 5000;

export const MODEL_SWITCH_CONFIRM_CONFIG_NAME = 'model_switch_confirm';

interface ModelSwitchRule {
  from: string | string[];
  to: string | string[];
  session_type: 'old' | 'new' | 'all';
  hint?: { en?: string; zh?: string };
  warning?: { en?: string; zh?: string };
}

interface ModelSwitchConfirmConfig {
  enable: boolean;
  rules: ModelSwitchRule[];
}

const modelIdListSchema = z.union([z.string(), z.array(z.string()).min(1)]);

const modelSwitchRuleSchema = z.object({
  from: modelIdListSchema,
  to: modelIdListSchema,
  session_type: z.enum(['old', 'new', 'all']),
  hint: z
    .object({
      en: z.string().optional(),
      zh: z.string().optional(),
    })
    .optional(),
  warning: z
    .object({
      en: z.string().optional(),
      zh: z.string().optional(),
    })
    .optional(),
});

const modelSwitchConfirmConfigSchema = z.unknown().transform((raw): ModelSwitchConfirmConfig => {
  if (typeof raw !== 'object' || raw === null) return { enable: false, rules: [] };
  const record = raw as Record<string, unknown>;
  const enable = z.boolean().safeParse(record['enable']);
  const rules: ModelSwitchRule[] = [];
  if (Array.isArray(record['rules'])) {
    for (const entry of record['rules']) {
      const parsed = modelSwitchRuleSchema.safeParse(entry);
      if (parsed.success) rules.push(parsed.data);
    }
  }
  return { enable: enable.success ? enable.data : false, rules };
});

export const EFFORT_SWITCH_CONFIG_NAME = 'effort_switch_confirm';

interface EffortSwitchConfig {
  descriptions: {
    enable: boolean;
    items: Record<string, { en?: string; zh?: string }>;
  };
  confirm: ModelSwitchConfirmConfig;
}

const effortSwitchDescriptionSchema = z.object({
  en: z.string().optional(),
  zh: z.string().optional(),
});

function parseEffortDescriptions(raw: unknown): EffortSwitchConfig['descriptions'] {
  if (typeof raw !== 'object' || raw === null) return { enable: false, items: {} };
  const record = raw as Record<string, unknown>;
  const enable = z.boolean().safeParse(record['enable']);
  const items: EffortSwitchConfig['descriptions']['items'] = {};
  const rawItems = record['items'];
  if (typeof rawItems === 'object' && rawItems !== null && !Array.isArray(rawItems)) {
    for (const [effort, value] of Object.entries(rawItems)) {
      const parsed = effortSwitchDescriptionSchema.safeParse(value);
      if (parsed.success) items[effort] = parsed.data;
    }
  }
  return { enable: enable.success ? enable.data : false, items };
}

const effortSwitchConfigSchema = z.unknown().transform((raw): EffortSwitchConfig => {
  if (typeof raw !== 'object' || raw === null) {
    return { descriptions: { enable: false, items: {} }, confirm: { enable: false, rules: [] } };
  }
  const record = raw as Record<string, unknown>;
  const confirm = modelSwitchConfirmConfigSchema.safeParse(record['confirm']);
  return {
    descriptions: parseEffortDescriptions(record['descriptions']),
    confirm: confirm.success ? confirm.data : { enable: false, rules: [] },
  };
});

const registry = new Map<string, z.ZodTypeAny>([
  [MODEL_SWITCH_CONFIRM_CONFIG_NAME, modelSwitchConfirmConfigSchema],
  [EFFORT_SWITCH_CONFIG_NAME, effortSwitchConfigSchema],
]);

export function isRegisteredClientConfig(name: string): boolean {
  return registry.has(name);
}

export function clientConfigsBaseUrl(
  baseUrlOverride: string | undefined,
  region: KimiRegion,
): string {
  const trimmed = baseUrlOverride?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed.replace(/\/+$/, '');
  }
  return KIMI_REGION_PROFILES[region].baseUrl;
}

export async function fetchClientConfig(
  name: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const schema = registry.get(name);
  if (schema === undefined) return undefined;
  try {
    const response = await fetchImpl(`${baseUrl}${CLIENT_CONFIGS_PATH}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return undefined;
    const envelope = body as Record<string, unknown>;
    if (envelope['name'] !== name) return undefined;
    const parsed = schema.safeParse(envelope['config']);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
