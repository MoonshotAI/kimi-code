/**
 * `contextMemory` domain — derives the model-visible window from its append-only log.
 *
 * Exposes immutable visible windows and visible-index-to-log-index mapping.
 * Indexes in a derived prefix are not representable in the source log.
 * Results are cached by log identity, with marker derivations reused only when
 * their input message identities match.
 */

import { deriveVisibleWindowAfterCompaction } from './compactionHandoff';
import type { ContextMessage } from './types';

const visibleWindowCache = new WeakMap<
  readonly ContextMessage[],
  readonly ContextMessage[]
>();

interface CachedMarkerDerivation {
  readonly inputs: readonly ContextMessage[];
  readonly result: readonly ContextMessage[];
}

const markerDerivationCache = new WeakMap<ContextMessage, CachedMarkerDerivation>();

function deriveWindowForMarker(
  inputs: readonly ContextMessage[],
  marker: ContextMessage,
): readonly ContextMessage[] {
  const cached = markerDerivationCache.get(marker);
  if (
    cached !== undefined &&
    cached.inputs.length === inputs.length &&
    cached.inputs.every((message, index) => message === inputs[index])
  ) {
    return cached.result;
  }
  const result = deriveVisibleWindowAfterCompaction(inputs, marker);
  markerDerivationCache.set(marker, { inputs, result });
  return result;
}

export function deriveVisibleMessages(
  log: readonly ContextMessage[],
): readonly ContextMessage[] {
  const cached = visibleWindowCache.get(log);
  if (cached !== undefined) return cached;
  const derived = computeVisibleMessages(log);
  visibleWindowCache.set(log, derived);
  return derived;
}

export function mapVisibleIndexToLog(
  log: readonly ContextMessage[],
  visible: readonly ContextMessage[],
  visibleIndex: number,
): number | undefined {
  if (log === visible) return visibleIndex;
  let lastMarker = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]!.compaction !== undefined) {
      lastMarker = i;
      break;
    }
  }
  if (lastMarker === -1) return visibleIndex;
  const tailLength = log.length - lastMarker - 1;
  const visibleTailStart = visible.length - tailLength;
  if (visibleIndex < visibleTailStart) return undefined;
  const logToVisibleOffset = log.length - visible.length;
  return visibleIndex + logToVisibleOffset;
}

function computeVisibleMessages(
  log: readonly ContextMessage[],
): readonly ContextMessage[] {
  let window: readonly ContextMessage[] = [];
  let cursor = 0;
  let sawMarker = false;
  for (let i = 0; i < log.length; i++) {
    const message = log[i]!;
    if (message.compaction === undefined) continue;
    sawMarker = true;
    window = deriveWindowForMarker([...window, ...log.slice(cursor, i)], message);
    cursor = i + 1;
  }
  if (!sawMarker) return log;
  return Object.freeze([...window, ...log.slice(cursor)]);
}
