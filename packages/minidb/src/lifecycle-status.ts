// src/lifecycle-status.ts
//
// Structured per-open lifecycle telemetry: the state machine one open() walks
// through and the wall-clock cost of every lifecycle phase, so operators and
// benches can tell a published-generation attach apart from a legacy full
// recovery WITHOUT inferring it from the cumulative stats counters. One
// tracker instance lives exactly one open (a MiniDb instance opens once);
// lifecycle.ts, generation-loader.ts, recovery.ts (through a sink) and the
// deferred text-build task feed it, and the public read model is
// MiniDb.lifecycleStatus().

/** The lifecycle states one open() walks through. */
export type MiniDbLifecycleState =
  /** Nothing has been loaded: the initial state, and the state of an open
   *  that found no published generation to even attempt (a fresh/legacy
   *  database, or generations disabled). */
  | 'no-generation'
  /** Loading a published generation's images (store + derived indexes). */
  | 'generation-load'
  /** Replaying the WAL delta past the loaded generation's checkpoint. */
  | 'wal-catch-up'
  /** The legacy full recovery + open-time index rebuild is running (no usable
   *  generation, or every candidate failed validation). */
  | 'full-rebuild'
  /** open() completed and every index is servable. */
  | 'ready'
  /** open() completed but at least one text index's base is still being built
   *  by the deferred background task — searches on it raise
   *  TextIndexBuildingError until the build commits. */
  | 'degraded';

/** Wall-clock milliseconds per lifecycle phase of the LAST open (0 for a
 *  phase the open never entered). Phases are NOT strictly nested:
 *  generationCandidateLoadMs contains the image-load / postings-check /
 *  wal-catch-up phases of the generation path, fullRecoveryMs contains the
 *  full-recovery path's walScan/walApply (and its staged text commit also
 *  lands in textRebuildMs), and a deferred text build's textRebuildMs is
 *  recorded after open() returned, while the instance sits in 'degraded'. */
export interface OpenPhaseTimings {
  /** The whole open() call. */
  openMs: number;
  /** tryLoadGeneration across every candidate (manifest validation, image
   *  loads, WAL-delta replay, failed-candidate resets). */
  generationCandidateLoadMs: number;
  /** Store image read + decode + bulk load (generation path). */
  storeImageLoadMs: number;
  /** dt / secondary / compound image loads, including the per-index rebuild
   *  of a corrupt or definition-mismatched image (generation path). */
  nonTextImageLoadMs: number;
  /** Text dictionary/docs image reads + base attach (generation path). */
  textImageLoadMs: number;
  /** Whole-file postings crc32 verification (generation path). */
  postingsIntegrityCheckMs: number;
  /** Frame scanning: the generation path's WAL-delta scan, or the full
   *  recovery's snapshot + WAL scans (the async scanner's time only). */
  walScanMs: number;
  /** Applying scanned frames to the store and the derived indexes. */
  walApplyMs: number;
  /** The legacy full recovery + open-time index rebuild block (recover() +
   *  rebuildAllIndexes()); 0 when a generation served the open. */
  fullRecoveryMs: number;
  /** Corpus tokenization work: per-index rebuilds during a generation load
   *  (bounded worker/inline or staged), the full-rebuild walk's staged text
   *  commit, and — after open() returned, under 'degraded' — the deferred
   *  background base builds. 0 on a healthy generation attach. */
  textRebuildMs: number;
}

/** How one text index's base was served by the last open. */
export type OpenTextIndexSource =
  /** Attached from the generation's images — no tokenization at all. */
  | 'image'
  /** Rebuilt by the bounded engine hosted in a worker thread. */
  | 'worker'
  /** Rebuilt by the bounded engine hosted inline on this thread. */
  | 'inline'
  /** Rebuilt by the staged in-thread build (the unbounded small-corpus path). */
  | 'staged'
  /** Still building in the deferred background task when open() returned. */
  | 'deferred';

/** The public read model (MiniDb.lifecycleStatus()). */
export interface MiniDbLifecycleStatus {
  state: MiniDbLifecycleState;
  /** The states the last open walked through, in order (deduped transitions;
   *  always starts at 'no-generation' — nothing is loaded before the first
   *  attempt). */
  path: MiniDbLifecycleState[];
  /** Epoch ms when open() completed; null while an open is still in flight
   *  (or after a failed open — a failed open never reaches ready/degraded). */
  openedAt: number | null;
  phases: OpenPhaseTimings;
  /** Per text index: how its base was served (absent = the index did not
   *  exist at open). A 'deferred' entry flips to its hosting mode when the
   *  background build commits. */
  textIndexes: Record<string, OpenTextIndexSource>;
  /** Text index names whose base build was still pending when open()
   *  returned — the reason for 'degraded'. */
  pendingTextIndexes: string[];
}

/** The mutable tracker behind MiniDb.lifecycleStatus(); driven by the
 *  lifecycle facets through the LifecycleHost / GenerationLoaderDeps views
 *  (same shared-by-reference discipline as the stats object). */
export class LifecycleTracker {
  private current: MiniDbLifecycleState = 'no-generation';
  private readonly transitions: MiniDbLifecycleState[] = ['no-generation'];
  private completedAt: number | null = null;
  private readonly pending = new Set<string>();
  private readonly textSources = new Map<string, OpenTextIndexSource>();
  readonly phases: OpenPhaseTimings = {
    openMs: 0,
    generationCandidateLoadMs: 0,
    storeImageLoadMs: 0,
    nonTextImageLoadMs: 0,
    textImageLoadMs: 0,
    postingsIntegrityCheckMs: 0,
    walScanMs: 0,
    walApplyMs: 0,
    fullRecoveryMs: 0,
    textRebuildMs: 0,
  };

  get state(): MiniDbLifecycleState {
    return this.current;
  }

  transition(next: MiniDbLifecycleState): void {
    if (next === this.current) return;
    this.current = next;
    this.transitions.push(next);
  }

  /** Add `ms` to one phase (phases accumulate across candidates/passes). */
  time(phase: keyof OpenPhaseTimings, ms: number): void {
    this.phases[phase] += ms;
  }

  noteTextIndexSource(name: string, source: OpenTextIndexSource): void {
    this.textSources.set(name, source);
  }

  /** A text index's base build was deferred to the background task: pending
   *  from here until the build commits (finishOpen maps this to 'degraded'). */
  markTextIndexPending(name: string): void {
    this.pending.add(name);
    this.textSources.set(name, 'deferred');
  }

  /** The deferred build for one index committed (source = its hosting mode);
   *  the last pending clear flips a completed open back to 'ready'. A finally
   *  failed build stays pending — the index keeps raising
   *  TextIndexBuildingError, which IS the degraded state. */
  clearTextIndexPending(name: string, source: Exclude<OpenTextIndexSource, 'image' | 'deferred'>): void {
    this.pending.delete(name);
    this.textSources.set(name, source);
    if (this.pending.size === 0 && this.completedAt !== null && this.current === 'degraded') {
      this.transition('ready');
    }
  }

  /** open() is about to return: servable ('ready') unless a deferred text
   *  build is still pending ('degraded'). */
  finishOpen(): void {
    this.completedAt = Date.now();
    this.transition(this.pending.size > 0 ? 'degraded' : 'ready');
  }

  snapshot(): MiniDbLifecycleStatus {
    return {
      state: this.current,
      path: [...this.transitions],
      openedAt: this.completedAt,
      phases: { ...this.phases },
      textIndexes: Object.fromEntries(this.textSources),
      pendingTextIndexes: [...this.pending],
    };
  }
}
