export type GlobalShortcutFailureReason = 'channel-disabled' | 'conflicted' | 'invalid';

export type GlobalShortcutResult = { ok: true } | { ok: false; reason: GlobalShortcutFailureReason };

const FAILURE_REASONS = new Set<GlobalShortcutFailureReason>(['channel-disabled', 'conflicted', 'invalid']);

export function asGlobalShortcutResult(value: unknown): GlobalShortcutResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { ok?: unknown; reason?: unknown };
  if (candidate.ok === true) {
    return { ok: true };
  }
  if (candidate.ok === false && FAILURE_REASONS.has(candidate.reason as GlobalShortcutFailureReason)) {
    return { ok: false, reason: candidate.reason as GlobalShortcutFailureReason };
  }
  return null;
}
