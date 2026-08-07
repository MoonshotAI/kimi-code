// src/wal-group.ts
//
// MiniDb's WAL group-commit + in-place recovery gating as a facet: the
// per-flush-group rollback registry (pendingGroups + the lastGroup cache) and
// the single-flight recovery chain state (walRecoveryChain / walRecoveryIdle /
// walRecoveryCovers). The side effects stay on the owner and are injected
// through WalGroupDeps: the unguarded per-key restore (which also feeds the
// generation build's mutation queue), the writeDisabled flag (a public MiniDb
// field, parked by the recovery worker), and the in-place recovery worker
// itself (it truncates the WAL path — see MiniDb.recoverWalInPlace).

import type { StoreRecord } from './store.js';
import type { WAL } from './wal.js';
import type { WalPoison } from './wal.js';

/** Per-flush-group rollback state: the pre-group logical record of every key
 *  the group's ops touched, plus the count of the group's ops still awaiting
 *  their frame's `done`. Created when the first op of a group applies. */
export interface WalGroup {
  /** pk → pre-group record. The earliest capture per key wins: several ops of
   *  one group on the same key roll back to the state before the FIRST of
   *  them, so the result matches what a reopen replays (the whole group's
   *  frames are truncated away together). */
  pre: Map<string, StoreRecord | undefined>;
  pending: number;
  /** Set once the group failed and was rolled back; later rejects are no-ops. */
  rolledBack: boolean;
}

/** The owner-injected surface the facet needs (see the header). */
export interface WalGroupDeps {
  /** Roll one key back to its pre-group record (the unguarded restore). */
  restoreGroupKey: (pk: string, prev: StoreRecord | undefined) => void;
  /** The owner's writeDisabled flag (read at call time). */
  writeDisabled: () => unknown;
  /** The in-place recovery worker for a poisoned WAL. */
  recoverWalInPlace: (wal: WAL) => Promise<void>;
}

export class WalGroupTracker {
  /** Pre-group rollback state of every in-flight flush group, keyed per WAL:
   *  a compaction rotation replaces the WAL and each side's batchIds are
   *  independent. Entries are dropped when their group fully settles. */
  private readonly pendingGroups = new Map<WAL, Map<number, WalGroup>>();
  /** The group groupFor returned most recently (see groupFor); invalidated
   *  when that group settles or rolls back. batchIds are monotonic per WAL,
   *  so a stale (wal, batchId) pair can never collide with a later group. */
  private lastGroup: { wal: WAL; batchId: number; group: WalGroup } | null = null;

  /** Serializes in-place WAL recoveries (poison → truncate → resume), the same
   *  promise-chain style as uniqueWriteLock. Never rejects (a failed recovery
   *  lands in writeDisabled instead). Non-private (package-internal by
   *  convention): MiniDb's close / catch-up / backup paths read it through
   *  private views. */
  walRecoveryChain: Promise<void> = Promise.resolve();
  /** False while a kicked recovery may still be running. Write-op commit
   *  bodies check it BEFORE awaiting walRecoveryChain: with no recovery in
   *  flight the commit path takes zero extra awaits (hot path), while a write
   *  issued after a failure queues behind the recovery instead of hitting the
   *  still-poisoned WAL. Non-private (see walRecoveryChain). */
  walRecoveryIdle = true;
  /** The poison object the current recovery chain covers (dedupe key for
   *  kickWalRecovery; each poison event is a fresh object identity). */
  private walRecoveryCovers: WalPoison | null = null;

  constructor(private readonly deps: WalGroupDeps) {}

  /** Register one op of a flush group (one call per op awaiting a frame) and
   *  return the group; null when the frame never entered a group (batchId < 0:
   *  a sealed/closed/poisoned appendLoc — those use the per-op rollback).
   *  lastGroup caches the previous lookup: ops of one flush burst share the
   *  same (wal, batchId), so they hit two reference compares instead of two
   *  map lookups. */
  groupFor(wal: WAL, batchId: number): WalGroup | null {
    if (batchId < 0) return null;
    const last = this.lastGroup;
    if (last && last.wal === wal && last.batchId === batchId) {
      last.group.pending++;
      return last.group;
    }
    let byId = this.pendingGroups.get(wal);
    if (!byId) {
      byId = new Map();
      this.pendingGroups.set(wal, byId);
    }
    let g = byId.get(batchId);
    if (!g) {
      g = { pre: new Map(), pending: 0, rolledBack: false };
      byId.set(batchId, g);
    }
    g.pending++;
    this.lastGroup = { wal, batchId, group: g };
    return g;
  }

  /** Record a key's pre-group record; the earliest capture per group wins. */
  groupNoteKey(group: WalGroup | null, pk: string, prev: StoreRecord | undefined): void {
    if (group && !group.pre.has(pk)) group.pre.set(pk, prev);
  }

  /** The op's frame landed: drop the group's pre-state once every op settled. */
  settleGroup(group: WalGroup | null, wal: WAL, batchId: number): void {
    if (!group) return;
    if (--group.pending === 0 && !group.rolledBack) {
      const byId = this.pendingGroups.get(wal);
      byId?.delete(batchId);
      if (byId && byId.size === 0) this.pendingGroups.delete(wal);
      if (this.lastGroup?.group === group) this.lastGroup = null;
    }
  }

  /** Roll a failed group back as a whole: every touched key returns to its
   *  pre-group record. Uses the unguarded restoreGroupKey — flush-group
   *  ordering itself guarantees no legally-committed later op exists (a
   *  poison rejects every queued frame, and the rollbacks unwind newest
   *  group first because the WAL rejects queued frames in reverse enqueue
   *  order), so the per-op seq guard would only misfire here: an earlier
   *  group's pre-state must win even after a later group's rollback re-seqd
   *  the record. Idempotent per group. */
  rollbackGroup(group: WalGroup | null, wal: WAL, batchId: number): void {
    if (!group || group.rolledBack) return;
    group.rolledBack = true;
    for (const [pk, prev] of group.pre) this.deps.restoreGroupKey(pk, prev);
    const byId = this.pendingGroups.get(wal);
    byId?.delete(batchId);
    if (byId && byId.size === 0) this.pendingGroups.delete(wal);
    if (this.lastGroup?.group === group) this.lastGroup = null;
  }

  /** Tag a failure past the commit point as ambiguous: the op's frame may
   *  have reached the OS — and its value was visible to in-process readers
   *  between applyOp and the group rollback — before the failure revoked it,
   *  so the caller must not assume the write had no effect. Errors thrown
   *  before the commit point (validation, unique violation, maxMemory,
   *  write-disabled) carry no flag: those definitely had no effect.
   *  WAL_SEALED is excluded too: retryOnWalSeal transparently retries it. */
  markAmbiguous(err: unknown): unknown {
    if (err && typeof err === 'object' && (err as { code?: string }).code !== 'WAL_SEALED') {
      (err as { ambiguous?: boolean }).ambiguous = true;
    }
    return err;
  }

  /** Kick the in-place recovery for a poisoned WAL (single-flight; recoveries
   *  serialize on walRecoveryChain). Called from op catches after the group
   *  rollback — many ops can share one poison event, so a recovery already
   *  chained for THIS poison object is not chained again (a write storm's
   *  worth of catches costs one recovery, not one per op). No-op for
   *  anything that did not poison the WAL (e.g. a seal rejection during a
   *  compaction rotation). */
  kickWalRecovery(wal: WAL): void {
    const poison = wal.poison;
    if (!poison || poison === this.walRecoveryCovers) return;
    this.walRecoveryCovers = poison;
    this.walRecoveryIdle = false;
    const run = this.walRecoveryChain.then(() => this.deps.recoverWalInPlace(wal));
    const chain = run.catch(() => {});
    this.walRecoveryChain = chain;
    void chain.finally(() => {
      // Idle again only once the LATEST kicked recovery settled (an earlier
      // chain's settle must not mark idle while a later one still runs).
      if (this.walRecoveryChain === chain) {
        this.walRecoveryIdle = true;
        this.walRecoveryCovers = null;
      }
    });
  }

  /** Write-op gate at the start of every commit body: throws synchronously
   *  while writes are disabled; returns the recovery chain to await while a
   *  recovery is in flight, null otherwise — so the hot path pays zero extra
   *  microtasks (`const g = this.walRecoveryGate(); if (g) await g;`).
   *  Correctness never depends on the gate alone: an op that races a poison
   *  past the check is still rejected by the WAL itself and rolls its group
   *  back. */
  walRecoveryGate(): Promise<void> | null {
    const writeDisabled = this.deps.writeDisabled();
    if (writeDisabled) throw this.writeDisabledError();
    return this.walRecoveryIdle ? null : this.walRecoveryChain;
  }

  writeDisabledError(): Error {
    const cause = this.deps.writeDisabled();
    return Object.assign(
      new Error(
        `MiniDb writes are disabled: in-place WAL recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
      { code: 'WAL_WRITE_DISABLED', cause },
    );
  }
}
