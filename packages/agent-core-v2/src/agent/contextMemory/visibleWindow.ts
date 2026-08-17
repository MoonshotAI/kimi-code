/**
 * `contextMemory` domain — derives the model-visible window from the
 * append-only folded log, the single read counterpart of the
 * `context.apply_compaction` fold.
 *
 * The log keeps every folded message; summary markers (messages carrying
 * `CompactionMeta`) delimit compaction boundaries. The visible window is what
 * the model sees: the pre-marker window folded through
 * `compactionHandoff.deriveCompactionWindow` at each marker, with the
 * post-last-marker tail passing through untouched — the same layout the
 * destructive rewrite used to store, now recomputed at read time from data
 * that never leaves the journal. Pure and deterministic, so live dispatch,
 * wire replay, and tests all derive identical windows from the same records.
 *
 * Results are memoized on the log array reference (the state is immutable, so
 * reference equality is cache validity); a marker-free log returns itself —
 * sessions that never compact pay nothing. A derived window is frozen before
 * caching: every consumer of the same log shares one immutable array, so an
 * in-place mutation attempt throws instead of silently polluting the cache —
 * the same contract the wire's frozen state array gave the bare-array state.
 * Each marker's derivation is additionally memoized per marker object, gated
 * on the marker's whole pre-marker input segment recurring object-for-object:
 * `deriveCompactionWindow` synthesizes fresh summary / elision messages on
 * every call, and without the reuse a mutation behind the last marker (an
 * append, an undo, the `swarm_mode.exit` pop) would re-derive a window whose
 * synthesized prefix no longer shares identity with the previous window's,
 * spuriously failing consumers that verify survivors by identity
 * (`contextMemory.publishTrailingRemoval`). Replay rehydration replaces
 * media-bearing survivors with new objects, which fails the identity gate
 * and forces a fresh derivation with the rehydrated parts.
 *
 * Also owns `mapVisibleIndexToLog`, the inverse positional mapping undo needs
 * to turn a cut inside the visible window back into a log cut: the post-last-
 * marker tail maps one-to-one with a constant offset; a cut inside the
 * derived prefix (only reachable past a verbatim legacy summary message the
 * undo walk cannot recognize) reports `undefined` so the caller can fall back
 * to the legacy destructive cut.
 */

import { deriveCompactionWindow } from './compactionHandoff';
import type { ContextMessage } from './types';

const visibleWindowCache = new WeakMap<
  readonly ContextMessage[],
  readonly ContextMessage[]
>();

/**
 * Per-marker derivation cache, keyed on the marker message object.
 */
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
  const result = deriveCompactionWindow(inputs, marker);
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
  const tailStart = visible.length - (log.length - lastMarker - 1);
  if (visibleIndex < tailStart) return undefined;
  return visibleIndex + (log.length - visible.length);
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
