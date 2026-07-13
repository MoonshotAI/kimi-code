import type { AppModel, ThinkingLevel } from '../api/types';

export type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

export type ModelThinkingInfo = Pick<
  AppModel,
  'capabilities' | 'supportEfforts' | 'defaultEffort'
> & {
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

function effortsOf(model: ModelThinkingInfo | undefined): readonly string[] {
  return model?.supportEfforts ?? [];
}

function middleOf(efforts: readonly string[]): string {
  return efforts[Math.floor(efforts.length / 2)]!;
}

/**
 * Default thinking level for a model:
 *  - unsupported / no model → 'off'
 *  - effort model          → defaultEffort, else the middle declared effort
 *  - boolean model         → 'on'
 */
export function defaultThinkingLevelFor(
  model: ModelThinkingInfo | undefined,
): ThinkingLevel {
  if (modelThinkingAvailability(model) === 'unsupported') return 'off';
  const efforts = effortsOf(model);
  if (efforts.length > 0) return model?.defaultEffort ?? middleOf(efforts);
  return 'on';
}

/**
 * UI segments (left → right) for a model's thinking control:
 *  - unsupported       → ['off']
 *  - boolean toggle    → ['on', 'off']            (On on the left, legacy layout)
 *  - boolean always-on → ['on']
 *  - effort toggle     → ['off', ...efforts]      (Off on the left)
 *  - effort always-on  → [...efforts]             (no Off segment)
 */
export function segmentsFor(model: ModelThinkingInfo | undefined): readonly string[] {
  const efforts = effortsOf(model);
  const availability = modelThinkingAvailability(model);
  if (efforts.length > 0) {
    return availability === 'always-on' ? [...efforts] : ['off', ...efforts];
  }
  if (availability === 'always-on') return ['on'];
  if (availability === 'unsupported') return ['off'];
  return ['on', 'off'];
}

/** Display label for a level: capitalize the first letter (off→Off, max→Max). */
export function effortLabel(effort: string): string {
  return effort.length === 0 ? effort : effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function isThinkingOn(level: ThinkingLevel): boolean {
  return level !== 'off';
}

/**
 * Coerce a carried-over level against a new model's capabilities when switching
 * models, so the level stays valid for the target:
 *  - unsupported                          → 'off'
 *  - always-on + 'off'                    → default level (always-on can't be off)
 *  - effort model + undeclared level      → default level
 *  - effort model + declared level        → requested
 *  - boolean model + non-'off'            → 'on'
 */
export function coerceThinkingForModel(
  model: ModelThinkingInfo | undefined,
  requested: ThinkingLevel,
): ThinkingLevel {
  // Model catalog (and thus the active model) is not known yet on early app
  // load — keep the requested/persisted level as-is. loadModels() re-runs this
  // coercion once models are available, so an effort like 'high' is not
  // rewritten to the boolean 'on' and silently lost.
  if (model === undefined) return requested;
  const availability = modelThinkingAvailability(model);
  if (availability === 'unsupported') return 'off';
  if (requested === 'off') {
    return availability === 'always-on' ? defaultThinkingLevelFor(model) : 'off';
  }
  const efforts = effortsOf(model);
  if (efforts.length > 0) {
    return efforts.includes(requested) ? requested : defaultThinkingLevelFor(model);
  }
  return 'on';
}

/**
 * Normalize a UI draft before it crosses the component boundary. 'on' never
 * leaks out of the control — it becomes the model's default level.
 */
export function commitLevel(
  model: ModelThinkingInfo | undefined,
  draft: string,
): ThinkingLevel {
  if (draft === 'off') return 'off';
  if (draft === 'on') return defaultThinkingLevelFor(model);
  return draft;
}

/**
 * Thinking level to use when the user picks a model in the switcher.
 * Mirrors the TUI model picker: switching onto a different effort-capable
 * model from 'off' pre-selects the model's default effort, so the user sees
 * the effort control immediately; re-selecting the current model or moving
 * to a boolean/unsupported model just coerces the carried-over level.
 */
export function thinkingLevelForModelSwitch(
  model: ModelThinkingInfo | undefined,
  currentLevel: ThinkingLevel,
  isSwitch: boolean,
): ThinkingLevel {
  if (isSwitch && currentLevel === 'off' && (model?.supportEfforts?.length ?? 0) > 0) {
    return defaultThinkingLevelFor(model);
  }
  return coerceThinkingForModel(model, currentLevel);
}
