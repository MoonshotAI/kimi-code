export const MODEL_SWITCH_CONFIRM_CONFIG_NAME = 'model_switch_confirm';

export interface ModelSwitchLocalizedString {
  en?: string;
  zh?: string;
}

export type ModelSwitchSessionType = 'old' | 'new' | 'all';

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

export type ModelSwitchAction = 'compact' | 'continue' | 'cancel';

function parseIdList(raw: unknown): string | string[] | undefined {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (raw.some((entry) => typeof entry !== 'string')) return undefined;
  return raw as string[];
}

function parseLocalizedString(raw: unknown): ModelSwitchLocalizedString | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record['en'] !== undefined && typeof record['en'] !== 'string') return null;
  if (record['zh'] !== undefined && typeof record['zh'] !== 'string') return null;
  return {
    en: typeof record['en'] === 'string' ? record['en'] : undefined,
    zh: typeof record['zh'] === 'string' ? record['zh'] : undefined,
  };
}

function parseRule(raw: unknown): ModelSwitchRule | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const from = parseIdList(record['from']);
  const to = parseIdList(record['to']);
  const sessionType = record['session_type'];
  if (from === undefined || to === undefined) return undefined;
  if (sessionType !== 'old' && sessionType !== 'new' && sessionType !== 'all') return undefined;
  const hint = parseLocalizedString(record['hint']);
  const warning = parseLocalizedString(record['warning']);
  if (hint === null || warning === null) return undefined;
  return {
    from,
    to,
    session_type: sessionType,
    hint: hint ?? undefined,
    warning: warning ?? undefined,
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
  sessionType: Exclude<ModelSwitchSessionType, 'all'>,
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

export function resolveModelSwitchWarning(
  rule: ModelSwitchRule | undefined,
  locale: 'en' | 'zh',
): string | undefined {
  if (rule?.warning === undefined) return undefined;
  return (locale === 'zh' ? rule.warning.zh : undefined) ?? rule.warning.en;
}
