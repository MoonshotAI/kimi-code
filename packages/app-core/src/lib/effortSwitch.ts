import {
  matchModelSwitchRule,
  parseModelSwitchConfirmConfig,
  parseModelSwitchLocalizedString,
  type ModelSwitchConfirmConfig,
  type ModelSwitchLocalizedString,
  type ModelSwitchRule,
  type ModelSwitchSessionType,
} from './modelSwitchConfirm';

export const EFFORT_SWITCH_CONFIG_NAME = 'effort_switch_confirm';

export type EffortSwitchRule = ModelSwitchRule;
export type EffortSwitchAction = 'continue' | 'cancel';

export interface EffortSwitchConfig {
  descriptions: {
    enable: boolean;
    items: Record<string, ModelSwitchLocalizedString>;
  };
  confirm: ModelSwitchConfirmConfig;
}

function parseDescriptions(raw: unknown): EffortSwitchConfig['descriptions'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { enable: false, items: {} };
  }
  const record = raw as Record<string, unknown>;
  const items: Record<string, ModelSwitchLocalizedString> = {};
  const rawItems = record['items'];
  if (typeof rawItems === 'object' && rawItems !== null && !Array.isArray(rawItems)) {
    for (const [effort, value] of Object.entries(rawItems)) {
      const parsed = parseModelSwitchLocalizedString(value);
      if (parsed !== null && parsed !== undefined) items[effort] = parsed;
    }
  }
  return { enable: record['enable'] === true, items };
}

export function matchEffortSwitchRule(
  config: EffortSwitchConfig | undefined,
  fromEffort: string,
  toEffort: string,
  sessionType: Exclude<ModelSwitchSessionType, 'all'>,
): EffortSwitchRule | undefined {
  return matchModelSwitchRule(config?.confirm, fromEffort, toEffort, sessionType);
}

export function parseEffortSwitchConfig(raw: unknown): EffortSwitchConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { descriptions: { enable: false, items: {} }, confirm: { enable: false, rules: [] } };
  }
  const record = raw as Record<string, unknown>;
  return {
    descriptions: parseDescriptions(record['descriptions']),
    confirm: parseModelSwitchConfirmConfig(record['confirm']),
  };
}

export function resolveEffortDescription(
  config: EffortSwitchConfig | undefined,
  effort: string,
  locale: 'en' | 'zh',
): string | undefined {
  if (config?.descriptions?.enable !== true) return undefined;
  const description = config.descriptions.items?.[effort];
  if (description === undefined) return undefined;
  return (locale === 'zh' ? description.zh : undefined) ?? description.en;
}
