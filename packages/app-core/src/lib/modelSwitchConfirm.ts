export const MODEL_SWITCH_CONFIRM_CONFIG_NAME = 'model_switch_confirm';

export interface ModelSwitchLocalizedString {
  en?: string;
  zh?: string;
}

export interface ModelSwitchRule {
  from: string | string[];
  to: string | string[];
  hint?: ModelSwitchLocalizedString;
}

export interface ModelSwitchConfirmConfig {
  enable: boolean;
  rules: ModelSwitchRule[];
}

export type ModelSwitchAction = 'new' | 'compact' | 'continue' | 'cancel';

function parseIdList(raw: unknown): string | string[] | undefined {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (raw.some((entry) => typeof entry !== 'string')) return undefined;
  return raw as string[];
}

function parseRule(raw: unknown): ModelSwitchRule | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const from = parseIdList(record['from']);
  const to = parseIdList(record['to']);
  if (from === undefined || to === undefined) return undefined;
  const hint = record['hint'];
  if (hint === undefined) return { from, to };
  if (typeof hint !== 'object' || hint === null) return undefined;
  const localized = hint as Record<string, unknown>;
  if (localized['en'] !== undefined && typeof localized['en'] !== 'string') return undefined;
  if (localized['zh'] !== undefined && typeof localized['zh'] !== 'string') return undefined;
  return {
    from,
    to,
    hint: {
      en: typeof localized['en'] === 'string' ? localized['en'] : undefined,
      zh: typeof localized['zh'] === 'string' ? localized['zh'] : undefined,
    },
  };
}

export function parseModelSwitchConfirmConfig(raw: unknown): ModelSwitchConfirmConfig {
  if (typeof raw !== 'object' || raw === null) return { enable: false, rules: [] };
  const record = raw as Record<string, unknown>;
  const enable = typeof record['enable'] === 'boolean' ? record['enable'] : false;
  const rules: ModelSwitchRule[] = [];
  if (Array.isArray(record['rules'])) {
    for (const entry of record['rules']) {
      const parsed = parseRule(entry);
      if (parsed !== undefined) rules.push(parsed);
    }
  }
  return { enable, rules };
}

export function matchModelSwitchRule(
  config: ModelSwitchConfirmConfig | undefined,
  fromModelId: string,
  toModelId: string,
): ModelSwitchRule | undefined {
  if (config === undefined || !config.enable) return undefined;
  const hit = (ids: string | string[], id: string): boolean =>
    typeof ids === 'string' ? ids === id : ids.includes(id);
  return config.rules.find((rule) => hit(rule.from, fromModelId) && hit(rule.to, toModelId));
}

export function upstreamModelIdFromConfigModels(
  models: Record<string, unknown> | undefined,
  aliasId: string,
): string | undefined {
  const entry = models?.[aliasId];
  if (typeof entry !== 'object' || entry === null) return undefined;
  const model = (entry as Record<string, unknown>)['model'];
  return typeof model === 'string' ? model : undefined;
}

export function resolveModelSwitchHint(
  rule: ModelSwitchRule | undefined,
  locale: 'en' | 'zh',
): string | undefined {
  if (rule?.hint === undefined) return undefined;
  return (locale === 'zh' ? rule.hint.zh : undefined) ?? rule.hint.en;
}
