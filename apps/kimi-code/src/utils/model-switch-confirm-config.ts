import { z } from 'zod';

import {
  fetchClientConfig,
  type ClientConfigFetchOptions,
} from '#/utils/client-configs';

const CONFIG_NAME = 'model_switch_confirm';

export type ModelSwitchAction = 'new' | 'compact' | 'continue' | 'cancel';

/** A string served per locale. The TUI is English-only and always reads the
 *  `en` arm; `zh` rides along in the payload for the multi-locale desktop
 *  client. */
export interface ModelSwitchLocalizedString {
  en?: string;
  zh?: string;
}

/** A confirm-dialog gate for one model switch: `from` and `to` are upstream
 *  model ids (e.g. `kimi-k2.5`), matched exactly — no wildcards. `hint`
 *  optionally overrides the built-in dialog body text for this pair. */
export interface ModelSwitchRule {
  from: string;
  to: string;
  hint?: ModelSwitchLocalizedString;
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

const modelSwitchRuleSchema = z.object({
  from: z.string(),
  to: z.string(),
  hint: localizedStringSchema.optional(),
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
 *  never persisted and has no TTL: the TUI refetches it once per process
 *  startup and the dialog gate reads only this memory copy. */
let cached: ModelSwitchConfirmConfig | undefined;

/** Always hits the network and replaces the in-process copy; a failed fetch
 *  leaves (or resets) the copy to undefined, gating the dialog off. */
export async function refreshModelSwitchConfirmConfig(
  options: ClientConfigFetchOptions = {},
): Promise<ModelSwitchConfirmConfig | undefined> {
  cached = await fetchClientConfig(CONFIG_NAME, modelSwitchConfirmConfigSchema, options);
  return cached;
}

/** Synchronous read of the in-process copy; undefined until the first
 *  successful refresh of this process. */
export function peekModelSwitchConfirmConfig(): ModelSwitchConfirmConfig | undefined {
  return cached;
}

/** Test hook: drop the in-process copy. */
export function resetModelSwitchConfirmConfigCache(): void {
  cached = undefined;
}

/** The first rule matching the (from, to) pair exactly, when the feature is
 *  enabled; undefined gates the dialog off. */
export function matchModelSwitchRule(
  config: ModelSwitchConfirmConfig | undefined,
  fromModelId: string,
  toModelId: string,
): ModelSwitchRule | undefined {
  if (config === undefined || !config.enable) return undefined;
  return config.rules.find((rule) => rule.from === fromModelId && rule.to === toModelId);
}

/** Resolve the dialog body text for a matched rule: the rule's English arm,
 *  or undefined when the rule carries no hint — the dialog then shows no body
 *  line. There is deliberately no built-in fallback copy. */
export function resolveModelSwitchHint(rule: ModelSwitchRule | undefined): string | undefined {
  return rule?.hint?.en;
}
