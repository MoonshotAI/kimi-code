// src/stats.ts
//
// The MiniDb stats object (observability counters) as a factory: same shape
// and initial values as the historical inline literal, shared by reference
// with every facet's structural subset view.

/** Create the MiniDb stats object (all counters zeroed). */
export function createMiniDbStats() {
  return {

    compactions: 0,
    compactErrors: 0,
    walBytesWritten: 0,
    walFsyncs: 0,
    /** Failed writev-class attempts on the WAL write path. Each one poisons
     *  the WAL and triggers an in-place recovery (truncate + resume). */
    walWriteErrors: 0,
    /** Failed fsync attempts; a background everysec failure never rejects a
     *  write — it surfaces only here and in lastWalFsyncError. A write-path
     *  ('always') fsync failure rejects its batch and poisons the WAL. */
    walFsyncErrors: 0,
    /** Sticky copy of the most recent fsync failure (never cleared). */
    lastWalFsyncError: null as unknown,
    /** Bytes currently queued in the live WAL's in-memory append buffer. */
    walQueuedBytes: 0,
    /** High-water mark of walQueuedBytes. */
    walMaxQueuedBytes: 0,
    /** WAL group commits (one per flushed batch) and the frames they carried. */
    walGroupCommits: 0,
    walGroupCommitFrames: 0,
    snapshotBytesWritten: 0,
    evictions: 0,
    maxMemoryRejections: 0,
    queryIndexHits: 0,
    // ---- lifecycle phase metrics (cumulative wall-clock ms / counts) ----
    /** Bytes and frames recovery scanned at open (snapshot + WAL). */
    recoveryBytes: 0,
    recoveryFrames: 0,
    recoveryDurationMs: 0,
    /** Open-time derived-index rebuilds (secondary + dt + compound). */
    indexRebuildDurationMs: 0,
    /** Values decoded by the open-time shared rebuild walk (0 when no
     *  value-derived index exists: the walk is metadata-only then). */
    indexRebuildDecoded: 0,
    /** Text-index (re)builds: at open and after each compaction. */
    textRebuildDurationMs: 0,
    /** Whole successful compactions, hook included. */
    compactionDurationMs: 0,
    /** The non-blocking snapshot phase of compaction. */
    compactionSnapshotDurationMs: 0,
    /** The rotation critical section of compaction (writes park meanwhile). */
    compactionRotationDurationMs: 0,
    /** Text-postings rebuild after a compaction rotation. */
    compactionPostingsDurationMs: 0,
    /** Cumulative time write ops spent parked on a compaction rotation. */
    compactionRotationPauseMs: 0,
    /** Set once a rotation's directory fsync reported EINVAL/ENOTSUP: this
     *  platform cannot make renames durable via the directory, so rotation
     *  durability is knowingly degraded (warned once), never silently. */
    dirFsyncUnsupported: false,
    /** Candidate keys iterated / values decoded / rows fed to a sort in query(). */
    queryCandidates: 0,
    queryDecoded: 0,
    querySortedRows: 0,
    // ---- persistent index generations (stage 5) ----
    /** Successful generation builds (published under generations/ + CURRENT). */
    generationBuilds: 0,
    /** Builds that failed with a real error (I/O, corruption). */
    generationBuildErrors: 0,
    /** Builds discarded because the ground shifted under them (rotation, WAL
     *  rollback, queue overflow, close) — expected churn, not an error. */
    generationBuildAborts: 0,
    generationBuildDurationMs: 0,
    /** Opens served by a published generation (no full index rebuild). */
    generationLoads: 0,
    /** Opens that fell back to the legacy full recovery (no/invalid
     *  generation); the sticky reason is in lastGenerationFallback. */
    generationLoadFallbacks: 0,
    lastGenerationFallback: null as string | null,
    generationLoadDurationMs: 0,
    /** Individual index images rejected at generation load (definition hash
     *  mismatch, corrupt file) and rebuilt from the loaded store. */
    generationIndexRebuilds: 0,
    // ---- stage 6: workerized maintenance ----
    /** Successful bounded text builds actually hosted by a worker thread. */
    textWorkerBuilds: 0,
    /** Bounded text builds hosted inline because worker startup was unavailable. */
    textWorkerFallbacks: 0,
    /** Sticky reason for the most recent inline fallback. */
    lastTextWorkerFallback: null as string | null,
    /** Worker runs that failed after the ready handshake (crash/OOM/ENOSPC).
     *  Expected owner/shutdown cancellation is not an error. */
    textWorkerErrors: 0,
    /** Deferred open-time text base builds (no-generation fallback path):
     *  bases committed by the background maintenance task, and builds that
     *  finally failed after every retry (their indexes keep raising
     *  TextIndexBuildingError until a later build attaches a base). */
    textDeferredBuilds: 0,
    textDeferredBuildErrors: 0,
  };
}

/** The MiniDb stats object shape (all facets take structural subsets). */
export type MiniDbStats = ReturnType<typeof createMiniDbStats>;
