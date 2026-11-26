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

export function defaultThinkingLevelFor(
  model: ModelThinkingInfo | undefined,
): ThinkingLevel {
  if (modelThinkingAvailability(model) === 'unsupported') return 'off';
  const efforts = effortsOf(model);
  if (efforts.length > 0) return model?.defaultEffort ?? middleOf(efforts);
  return 'on';
}

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

export function effortLabel(effort: string): string {
  return effort.length === 0 ? effort : effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function isThinkingOn(level: ThinkingLevel): boolean {
  return level !== 'off';
}

export function levelDeclaredBy(
  model: ModelThinkingInfo | undefined,
  level: string,
): boolean {
  return segmentsFor(model).includes(level);
}

export function commitLevel(
  model: ModelThinkingInfo | undefined,
  draft: string,
): ThinkingLevel {
  if (draft === 'off') return 'off';
  if (draft === 'on') return defaultThinkingLevelFor(model);
  return draft;
}

export function effectiveThinkingLevel(
  model: ModelThinkingInfo | undefined,
  level: ThinkingLevel | undefined,
): ThinkingLevel {
  return level ?? defaultThinkingLevelFor(model);
}

export function thinkingLevelToConfig(level: ThinkingLevel): {
  enabled: boolean;
  effort?: string;
} {
  if (level === 'off') return { enabled: false };
  if (level === 'on') return { enabled: true };
  return { enabled: true, effort: level };
}

export function thinkingLevelFromConfig(
  thinking: unknown,
  model: ModelThinkingInfo | undefined,
): ThinkingLevel | undefined {
  if (!thinking || typeof thinking !== 'object') return undefined;
  const { enabled, effort } = thinking as { enabled?: boolean; effort?: string };
  if (enabled === false) return levelDeclaredBy(model, 'off') ? 'off' : undefined;
  if (typeof effort === 'string' && levelDeclaredBy(model, effort)) return effort;
  return undefined;
}

export function thinkingLevelForModelSwitch(
  model: ModelThinkingInfo | undefined,
  currentLevel: ThinkingLevel | undefined,
  isSwitch: boolean,
  configThinking?: unknown,
): ThinkingLevel | undefined {
  if (!isSwitch || model === undefined) return currentLevel;
  return thinkingLevelFromConfig(configThinking, model) ?? defaultThinkingLevelFor(model);
}

export function thinkingLevelKeptAcrossModelSwitch(
  model: ModelThinkingInfo | undefined,
  currentLevel: ThinkingLevel | undefined,
): ThinkingLevel {
  return currentLevel !== undefined && levelDeclaredBy(model, currentLevel)
    ? currentLevel
    : defaultThinkingLevelFor(model);
}

let thinkingWriteSeq = 0;

export function markThinkingPending(
  state: { pendingThinkingBySession: Record<string, number> },
  sessionId: string,
): number {
  const token = ++thinkingWriteSeq;
  state.pendingThinkingBySession[sessionId] = token;
  return token;
}

export function ackThinkingPending(
  state: { pendingThinkingBySession: Record<string, number> },
  sessionId: string,
  token: number | undefined,
): boolean {
  if (token === undefined || state.pendingThinkingBySession[sessionId] !== token) return false;
  delete state.pendingThinkingBySession[sessionId];
  return true;
}

export function foldDaemonThinkingLevel(
  state: {
    thinkingBySession: Record<string, ThinkingLevel>;
    pendingThinkingBySession: Record<string, number>;
  },
  sessionId: string,
  daemonLevel: ThinkingLevel,
): void {
  if (state.pendingThinkingBySession[sessionId] !== undefined) return;
  state.thinkingBySession[sessionId] = daemonLevel;
}
