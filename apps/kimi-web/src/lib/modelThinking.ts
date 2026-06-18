import type { AppModel, ThinkingLevel } from '../api/types';

export type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

export type ModelThinkingInfo = Pick<AppModel, 'capabilities'> & {
  readonly adaptiveThinking?: boolean;
};

export function modelThinkingAvailability(
  model: ModelThinkingInfo | undefined,
): ThinkingAvailability {
  if (model === undefined) return 'toggle';
  const capabilities = model.capabilities ?? [];
  if (capabilities.includes('always_thinking')) return 'always-on';
  if (capabilities.includes('thinking') || model.adaptiveThinking === true) return 'toggle';
  return 'unsupported';
}

export function coerceThinkingForModel(
  model: ModelThinkingInfo | undefined,
  requested: ThinkingLevel,
): ThinkingLevel {
  switch (modelThinkingAvailability(model)) {
    case 'always-on':
      return requested === 'off' ? 'high' : requested;
    case 'unsupported':
      return 'off';
    case 'toggle':
      return requested;
  }
}
