import { z } from 'zod';

import type { ClientConfigFetchOptions } from '@moonshot-ai/kimi-code-product/client-configs/node';

import { clientConfigs } from '#/utils/client-configs';
import {
  matchModelSwitchRule,
  type ModelSwitchConfirmConfig,
  type ModelSwitchLocalizedString,
  type ModelSwitchRule,
  type ModelSwitchSessionType,
} from './model-switch-confirm-config';

export const EFFORT_SWITCH_CONFIG_NAME = 'effort_switch_confirm';

export type EffortSwitchRule = ModelSwitchRule;

export interface EffortSwitchConfig {
  descriptions: {
    enable: boolean;
    items: Record<string, ModelSwitchLocalizedString>;
  };
  confirm: ModelSwitchConfirmConfig;
}

export const DEFAULT_EFFORT_SWITCH_CONFIG: EffortSwitchConfig = {
  descriptions: { enable: false, items: {} },
  confirm: { enable: false, rules: [] },
};

const localizedStringSchema = z.object({
  en: z.string().optional(),
  zh: z.string().optional(),
});

const effortListSchema = z.union([z.string(), z.array(z.string()).min(1)]);

const effortSwitchRuleSchema = z.object({
  from: effortListSchema,
  to: effortListSchema,
  session_type: z.enum(['old', 'new', 'all']),
  hint: localizedStringSchema.optional(),
  warning: localizedStringSchema.optional(),
});

function parseConfirm(raw: unknown): ModelSwitchConfirmConfig {
  if (typeof raw !== 'object' || raw === null) return { enable: false, rules: [] };
  const record = raw as Record<string, unknown>;
  const enable = z.boolean().safeParse(record['enable']);
  const rules: ModelSwitchRule[] = [];
  if (Array.isArray(record['rules'])) {
    for (const entry of record['rules']) {
      const parsed = effortSwitchRuleSchema.safeParse(entry);
      if (parsed.success) rules.push(parsed.data);
    }
  }
  return { enable: enable.success ? enable.data : false, rules };
}

function parseDescriptions(raw: unknown): EffortSwitchConfig['descriptions'] {
  if (typeof raw !== 'object' || raw === null) return { enable: false, items: {} };
  const record = raw as Record<string, unknown>;
  const enable = z.boolean().safeParse(record['enable']);
  const items: Record<string, ModelSwitchLocalizedString> = {};
  const rawItems = record['items'];
  if (typeof rawItems === 'object' && rawItems !== null && !Array.isArray(rawItems)) {
    for (const [effort, value] of Object.entries(rawItems)) {
      const parsed = localizedStringSchema.safeParse(value);
      if (parsed.success) items[effort] = parsed.data;
    }
  }
  return { enable: enable.success ? enable.data : false, items };
}

const effortSwitchConfigSchema = z.unknown().transform((raw): EffortSwitchConfig => {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_EFFORT_SWITCH_CONFIG;
  const record = raw as Record<string, unknown>;
  return {
    descriptions: parseDescriptions(record['descriptions']),
    confirm: parseConfirm(record['confirm']),
  };
});

let cached: EffortSwitchConfig | undefined;
let loadState: 'idle' | 'loading' | 'settled' = 'idle';
let inFlight:
  | {
      accessToken?: string;
      fetchImpl?: typeof fetch;
      path?: string;
      region: ReturnType<typeof clientConfigs.region>;
      request: Promise<EffortSwitchConfig | undefined>;
    }
  | undefined;
let latestRequest: object | undefined;

export async function refreshEffortSwitchConfig(
  options: ClientConfigFetchOptions = {},
): Promise<EffortSwitchConfig | undefined> {
  const region = clientConfigs.region();
  if (
    inFlight !== undefined &&
    inFlight.accessToken === options.accessToken &&
    inFlight.fetchImpl === options.fetchImpl &&
    inFlight.path === options.path &&
    inFlight.region === region
  ) {
    return inFlight.request;
  }
  cached = undefined;
  loadState = 'loading';
  const requestId = {};
  latestRequest = requestId;
  const request = (async () => {
    const next = await clientConfigs.fetch(EFFORT_SWITCH_CONFIG_NAME, effortSwitchConfigSchema, options);
    if (latestRequest === requestId) cached = next;
    return next;
  })();
  inFlight = {
    accessToken: options.accessToken,
    fetchImpl: options.fetchImpl,
    path: options.path,
    region,
    request,
  };
  try {
    return await request;
  } finally {
    if (latestRequest === requestId) loadState = 'settled';
    if (inFlight?.request === request) inFlight = undefined;
  }
}

export function needsEffortSwitchConfigRefresh(): boolean {
  return cached === undefined && loadState !== 'settled';
}

export function peekEffortSwitchConfig(): EffortSwitchConfig | undefined {
  return cached;
}

export function resetEffortSwitchConfigCache(): void {
  cached = undefined;
  loadState = 'idle';
  inFlight = undefined;
  latestRequest = undefined;
}

export function matchEffortSwitchRule(
  config: EffortSwitchConfig | undefined,
  fromEffort: string,
  toEffort: string,
  sessionType: Exclude<ModelSwitchSessionType, 'all'>,
): EffortSwitchRule | undefined {
  return matchModelSwitchRule(config?.confirm, fromEffort, toEffort, sessionType);
}

export function resolveEffortDescription(
  config: EffortSwitchConfig | undefined,
  effort: string,
): string | undefined {
  if (config?.descriptions?.enable !== true) return undefined;
  return config.descriptions.items?.[effort]?.en;
}
