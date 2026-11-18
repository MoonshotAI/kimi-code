import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';

import { ACP_MODES, type AcpModeId } from './modes';
import type { AcpModelEntry } from './model-catalog';

export function buildModelOption(
  models: readonly AcpModelEntry[],
  currentBaseModelId: string,
): SessionConfigOption {
  const options: SessionConfigSelectOption[] = models.map((model) => ({
    value: model.id,
    name: model.name,
    ...(model.description !== undefined ? { description: model.description } : {}),
  }));
  return {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: currentBaseModelId,
    options,
  };
}

export function buildThinkingOption(
  currentLevel: string,
  alwaysThinking = false,
  supportEfforts?: readonly string[],
): SessionConfigOption {
  const values = supportEfforts !== undefined ? ['off', ...supportEfforts] : ['off', 'on'];
  const options: SessionConfigSelectOption[] = values
    .filter((value) => !(alwaysThinking && value === 'off'))
    .map((value) => ({ value, name: thinkingOptionName(value) }));
  if (!options.some((option) => option.value === currentLevel)) {
    options.push({ value: currentLevel, name: thinkingOptionName(currentLevel) });
  }
  return {
    type: 'select',
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    currentValue: currentLevel,
    options,
  };
}

function thinkingOptionName(value: string): string {
  return `Thinking ${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function buildModeOption(currentModeId: AcpModeId): SessionConfigOption {
  const options: SessionConfigSelectOption[] = ACP_MODES.map((mode) => ({
    value: mode.id,
    name: mode.name,
    description: mode.description,
  }));
  return {
    type: 'select',
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    currentValue: currentModeId,
    options,
  };
}

export function buildSessionConfigOptions(
  models: readonly AcpModelEntry[],
  currentBaseModelId: string,
  currentThinkingLevel: string,
  currentModeId: AcpModeId,
): SessionConfigOption[] {
  const currentModelEntry = models.find((m) => m.id === currentBaseModelId);
  const showThinking = currentModelEntry?.thinkingSupported === true;
  const alwaysThinking = currentModelEntry?.alwaysThinking === true;
  const out: SessionConfigOption[] = [buildModelOption(models, currentBaseModelId)];
  if (showThinking) {
    const level = alwaysThinking && currentThinkingLevel === 'off' ? 'on' : currentThinkingLevel;
    out.push(buildThinkingOption(level, alwaysThinking, currentModelEntry?.supportEfforts));
  }
  out.push(buildModeOption(currentModeId));
  return out;
}
