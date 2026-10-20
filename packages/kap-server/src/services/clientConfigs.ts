import { KIMI_REGION_PROFILES, type KimiRegion } from '@moonshot-ai/kimi-code-oauth';
import { z } from 'zod';

const CLIENT_CONFIGS_PATH = '/client_configs';
const FETCH_TIMEOUT_MS = 5000;

export const MODEL_SWITCH_CONFIRM_CONFIG_NAME = 'model_switch_confirm';

interface ModelSwitchRule {
  from: string;
  to: string;
  hint?: { en?: string; zh?: string };
}

interface ModelSwitchConfirmConfig {
  enable: boolean;
  rules: ModelSwitchRule[];
}

const modelSwitchRuleSchema = z.object({
  from: z.string(),
  to: z.string(),
  hint: z
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

const registry = new Map<string, z.ZodTypeAny>([
  [MODEL_SWITCH_CONFIRM_CONFIG_NAME, modelSwitchConfirmConfigSchema],
]);

const configs = new Map<string, unknown>();

export function isRegisteredClientConfig(name: string): boolean {
  return registry.has(name);
}

export function peekClientConfig(name: string): unknown {
  return configs.get(name);
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

export interface RefreshClientConfigsOptions {
  readonly baseUrlOverride?: string;
  readonly fetchImpl?: typeof fetch;
}

export async function refreshClientConfigs(
  region: KimiRegion,
  options: RefreshClientConfigsOptions = {},
): Promise<void> {
  const baseUrl = clientConfigsBaseUrl(options.baseUrlOverride, region);
  await Promise.all(
    [...registry.keys()].map(async (name) => {
      const config = await fetchClientConfig(name, baseUrl, options.fetchImpl);
      if (config !== undefined) configs.set(name, config);
    }),
  );
}

export function resetClientConfigsForTest(): void {
  configs.clear();
}
