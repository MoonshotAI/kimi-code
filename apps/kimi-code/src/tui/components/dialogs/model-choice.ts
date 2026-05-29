/**
 * Shared model-domain helpers used by the single-select ModelSelectorComponent
 * (/model) and the multi-select CatalogModelMultiSelectComponent (/connect).
 * Lives outside both components so neither has to import from the other.
 */

import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import { DEFAULT_OAUTH_PROVIDER_NAME, PRODUCT_NAME } from '#/constant/app';
import type { ColorPalette } from '#/tui/theme/colors';

export type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

export interface ModelChoice {
  readonly alias: string;
  readonly model: ModelAlias;
  readonly label: string;
}

export function modelDisplayName(alias: string, model: ModelAlias | undefined): string {
  return model?.displayName ?? model?.model ?? alias;
}

export function providerDisplayName(provider: string): string {
  if (provider === DEFAULT_OAUTH_PROVIDER_NAME) return PRODUCT_NAME;
  if (provider.startsWith('managed:')) return provider.slice('managed:'.length);
  return provider;
}

export function createModelChoices(models: Record<string, ModelAlias>): readonly ModelChoice[] {
  return Object.entries(models).map(([alias, cfg]) => ({
    alias,
    model: cfg,
    label: `${modelDisplayName(alias, cfg)} (${providerDisplayName(cfg.provider)})`,
  }));
}

export function thinkingAvailability(model: ModelAlias): ThinkingAvailability {
  const caps = model.capabilities ?? [];
  if (caps.includes('always_thinking')) return 'always-on';
  if (caps.includes('thinking')) return 'toggle';
  return 'unsupported';
}

export function effectiveThinking(model: ModelAlias, thinkingDraft: boolean): boolean {
  const availability = thinkingAvailability(model);
  if (availability === 'always-on') return true;
  if (availability === 'unsupported') return false;
  return thinkingDraft;
}

export function renderThinkingControl(
  model: ModelAlias,
  thinkingDraft: boolean,
  colors: ColorPalette,
): string {
  const segment = (label: string, active: boolean): string =>
    active
      ? chalk.hex(colors.primary).bold(`[ ${label} ]`)
      : chalk.hex(colors.text)(`  ${label}  `);

  const availability = thinkingAvailability(model);
  if (availability === 'always-on') {
    return `  ${segment('Always on', true)}`;
  }
  if (availability === 'unsupported') {
    return `  ${segment('Off', true)} ${chalk.hex(colors.textMuted)('unsupported')}`;
  }
  return `  ${segment('On', thinkingDraft)}  ${segment('Off', !thinkingDraft)}`;
}
