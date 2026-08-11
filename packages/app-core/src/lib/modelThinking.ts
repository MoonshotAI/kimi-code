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

/** True when the level is selectable for the model (one of its UI segments). */
export function levelDeclaredBy(
  model: ModelThinkingInfo | undefined,
  level: string,
): boolean {
  return segmentsFor(model).includes(level);
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
 * The level that effectively applies when the stored level is `undefined`
 * (no explicit preference): the model's own default. Submitting a prompt with
 * no thinking override lets the daemon resolve the same value, so this is what
 * the UI displays and what `/thinking` cycles from.
 */
export function effectiveThinkingLevel(
  model: ModelThinkingInfo | undefined,
  level: ThinkingLevel | undefined,
): ThinkingLevel {
  return level ?? defaultThinkingLevelFor(model);
}

/**
 * Project a thinking level onto the daemon's `[thinking]` config section —
 * the same mapping the TUI persists (thinkingEffortToConfig): 'off' disables
 * thinking, boolean 'on' records only `enabled` (boolean models resolve back
 * to 'on' at runtime), and a concrete effort is recorded as the global
 * default — EXCEPT the model's highest declared level (the last entry of
 * `support_efforts`, ordered by strength), which is session-only and records
 * just `enabled`, so the most expensive tier never becomes the global
 * default for every new session. When the model's levels are unknown the
 * concrete level is persisted as-is.
 */
export function thinkingLevelToConfig(
  level: ThinkingLevel,
  supportEfforts?: readonly string[],
): {
  enabled: boolean;
  effort?: string;
} {
  if (level === 'off') return { enabled: false };
  if (level === 'on') return { enabled: true };
  const top = supportEfforts?.at(-1);
  if (top !== undefined && level === top) return { enabled: true };
  return { enabled: true, effort: level };
}

/**
 * Thinking level to use when the user picks a model in the switcher.
 * Mirrors the TUI model picker: re-selecting the current model keeps the live
 * level untouched (including "no preference"). Switching onto a different model
 * pre-selects that model's catalog default level. The carried-over level is
 * never coerced onto the target model.
 */
export function thinkingLevelForModelSwitch(
  model: ModelThinkingInfo | undefined,
  currentLevel: ThinkingLevel | undefined,
  isSwitch: boolean,
): ThinkingLevel | undefined {
  // Target model unknown (catalog not loaded yet): keep the current level
  // as-is rather than guessing at capabilities.
  if (!isSwitch || model === undefined) return currentLevel;
  return defaultThinkingLevelFor(model);
}

// Monotonic source for pending-write tokens: token (not level) equality
// decides which completion acks which write — the same level can be written
// twice with another level in between.
let thinkingWriteSeq = 0;

/**
 * Mark a locally written pick as not yet acknowledged by the daemon, returning
 * its write token. While pending, every daemon report is dropped
 * (foldDaemonThinkingLevel) — a report cannot tell which write it reflects, so
 * only the write's own completion acks (ackThinkingPending).
 */
export function markThinkingPending(
  state: { pendingThinkingBySession: Record<string, number> },
  sessionId: string,
): number {
  const token = ++thinkingWriteSeq;
  state.pendingThinkingBySession[sessionId] = token;
  return token;
}

/** Clear the pending mark for a completed write; a newer pick keeps its own
 *  shield. Returns whether the mark was cleared. */
export function ackThinkingPending(
  state: { pendingThinkingBySession: Record<string, number> },
  sessionId: string,
  token: number | undefined,
): boolean {
  if (token === undefined || state.pendingThinkingBySession[sessionId] !== token) return false;
  delete state.pendingThinkingBySession[sessionId];
  return true;
}

/** Fold a daemon-reported level into the session's own entry — dropped while a
 *  local pick is pending (markThinkingPending). */
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
