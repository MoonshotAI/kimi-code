import { z } from 'zod';

import type { ClientConfigFetchOptions } from '@moonshot-ai/kimi-code-product/client-configs/node';

import { clientConfigs } from '#/utils/client-configs';

const CONFIG_NAME = 'model_switch_confirm';

export type ModelSwitchAction = 'compact' | 'continue' | 'cancel';
export type ModelSwitchSessionType = 'old' | 'new' | 'all';

/** A string served per locale. The TUI is English-only and always reads the
 *  `en` arm; `zh` rides along in the payload for the multi-locale desktop
 *  client. */
export interface ModelSwitchLocalizedString {
  en?: string;
  zh?: string;
}

/** A confirm-dialog gate for one model switch. `from` and `to` match upstream
 *  model ids exactly, or any id when the whole field is `*`. The first rule
 *  matching the actual session type and both ids owns the dialog content. */
export interface ModelSwitchRule {
  from: string | string[];
  to: string | string[];
  session_type: ModelSwitchSessionType;
  hint?: ModelSwitchLocalizedString;
  warning?: ModelSwitchLocalizedString;
}

export interface ModelSwitchConfirmConfig {
  enable: boolean;
  rules: ModelSwitchRule[];
}

/** Fetch/parse failures resolve to this disabled default, i.e. no dialog. */
export const DEFAULT_MODEL_SWITCH_CONFIRM_CONFIG: ModelSwitchConfirmConfig = {
  enable: false,
  rules: [],
};

const localizedStringSchema = z.object({
  en: z.string().optional(),
  zh: z.string().optional(),
});

const modelIdListSchema = z.union([z.string(), z.array(z.string()).min(1)]);

const modelSwitchRuleSchema = z.object({
  from: modelIdListSchema,
  to: modelIdListSchema,
  session_type: z.enum(['old', 'new', 'all']),
  hint: localizedStringSchema.optional(),
  warning: localizedStringSchema.optional(),
});

const modelSwitchConfirmConfigSchema = z.unknown().transform((raw): ModelSwitchConfirmConfig => {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_MODEL_SWITCH_CONFIRM_CONFIG;
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

/** In-process copy of the config. Unlike the other named configs this one is
 *  never persisted and has no TTL: startup and auth-context changes refresh
 *  it, and the dialog gate reads only this memory copy. */
let cached: ModelSwitchConfirmConfig | undefined;
let loadState: 'idle' | 'loading' | 'settled' = 'idle';
let inFlight:
  | {
      accessToken?: string;
      fetchImpl?: typeof fetch;
      path?: string;
      region: ReturnType<typeof clientConfigs.region>;
      request: Promise<ModelSwitchConfirmConfig | undefined>;
    }
  | undefined;
let latestRequest: object | undefined;

/** Starts a network refresh, or joins one for the same auth context. Automatic
 *  picker loads stop after the first settled attempt; explicit refreshes still
 *  always refetch. A failed fetch disables the dialog until such a refresh. */
export async function refreshModelSwitchConfirmConfig(
  options: ClientConfigFetchOptions = {},
): Promise<ModelSwitchConfirmConfig | undefined> {
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
    const next = await clientConfigs.fetch(CONFIG_NAME, modelSwitchConfirmConfigSchema, options);
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

export function needsModelSwitchConfirmConfigRefresh(): boolean {
  return cached === undefined && loadState !== 'settled';
}

/** Synchronous read of the in-process copy; undefined until the first
 *  successful refresh of this process. */
export function peekModelSwitchConfirmConfig(): ModelSwitchConfirmConfig | undefined {
  return cached;
}

/** Test hook: drop the in-process copy. */
export function resetModelSwitchConfirmConfigCache(): void {
  cached = undefined;
  loadState = 'idle';
  inFlight = undefined;
  latestRequest = undefined;
}

export function matchModelSwitchRule(
  config: ModelSwitchConfirmConfig | undefined,
  fromModelId: string,
  toModelId: string,
  sessionType: 'old' | 'new',
): ModelSwitchRule | undefined {
  if (config === undefined || !config.enable) return undefined;
  const hit = (ids: string | string[], id: string): boolean =>
    ids === '*' || (typeof ids === 'string' ? ids === id : ids.includes(id));
  return config.rules.find(
    (rule) =>
      (rule.session_type === 'all' || rule.session_type === sessionType) &&
      hit(rule.from, fromModelId) &&
      hit(rule.to, toModelId),
  );
}

/** Resolve the dialog body text for a matched rule: the rule's English arm,
 *  or undefined when the rule carries no hint — the dialog then shows no body
 *  line. There is deliberately no built-in fallback copy. */
export function resolveModelSwitchHint(rule: ModelSwitchRule | undefined): string | undefined {
  return rule?.hint?.en;
}

export function resolveModelSwitchWarning(rule: ModelSwitchRule | undefined): string | undefined {
  return rule?.warning?.en;
}
