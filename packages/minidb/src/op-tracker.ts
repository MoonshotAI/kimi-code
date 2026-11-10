// src/op-tracker.ts
//
// OpTracker — the single "close gate + in-flight count" lifecycle primitive
// behind every drain path in MiniDB / cluster (plan 12). It generalizes the
// stage-8 close state machine: stage 8 made cleanup exception-safe, this
// makes the work in flight at shutdown bounded and convergent.
//
// The shape:
//
//   enter(): boolean  — gate open: count +1 and the caller owns one leave();
//                       gate closed: returns false, the caller rejects/skips
//                       the operation (never blocks).
//   leave(): void     — releases one enter(); at count 0 every idle waiter
//                       resolves.
//   close(): Promise  — TERMINAL: closes the gate for good and resolves once
//                       the count drains to 0. Concurrent calls share the
//                       same promise.
//   pause()/resume()  — a REOPENABLE close: pause() closes the gate and drains
//                       (the drain completion is a quiescence/linearization
//                       point — every op acknowledged before it is fenced in,
//                       every op after it was rejected), resume() reopens.
//                       pause() is reference-counted: overlapping pausers all
//                       drain, the gate reopens only when the LAST one
//                       resumes, and the gate closes synchronously at pause()
//                       call time (before its returned promise is awaited).
//                       resume() after close() is a no-op.
//   whenIdle(): Promise — resolves the next time the count reaches 0 without
//                       touching the gate (a point-in-time quiescence wait:
//                       new ops may still enter while it is pending).
//
// Current consumers:
//   - wal.ts: the everysec background sync registers each in-flight sync;
//     WAL.close() = stop the timer → bgSync.close() (drain) → flush → final
//     sync → close the fd (review #13).
//   - cluster/lock-pool.ts: one tracker per handle class; every
//     withWriter/withReader wraps acquire + callback in enter/leave, so
//     closeAll() = close both gates → both drains → close the handles — a
//     callback in flight at closeAll runs to completion instead of dying on a
//     'MiniDb is closed' handle teardown (review #18).
//   - index.ts (MiniDb): set/del/batch/expire enter the write tracker;
//     backup() = pause() (the fence + drain IS its linearization point) →
//     copy → resume() (review #22).
//
// kap-server consumer (plan 13): GlobalSearchService gives its
// lifecycle-managed background work (sync passes, read-only refreshes) one
// tracker; op bodies run under `if (!tracker.enter()) return; try { … }
// finally { tracker.leave(); }`, and dispose() is exactly `await
// tracker.close()` before closing the db — no detached promise can touch a
// closed db (review #20). A maintenance window that must exclude concurrent
// work (compact, resnapshot, generation swap) uses pause()/resume() the way
// MiniDb.backup does: pause's drain completion is the linearization point,
// work submitted meanwhile rejects synchronously at enter() — it never parks,
// so shutdown can never deadlock against it.
//
// Re-exported from the package root for that kap-server consumer.

export class OpTracker {
  private count = 0;
  private open = true;
  private pausers = 0;
  private permanentlyClosed = false;
  private idleWaiters: (() => void)[] = [];
  private closePromise: Promise<void> | null = null;

  /** In-flight op count (diagnostics and tests). */
  get inFlight(): number {
    return this.count;
  }

  /** False once the gate is closed (pause or close). */
  get gateOpen(): boolean {
    return this.open;
  }

  /** Try to register one op. True: the caller owns exactly one leave().
   *  False: the gate is closed — reject or skip the op, never block. */
  enter(): boolean {
    if (!this.open) return false;
    this.count++;
    return true;
  }

  /** Release one enter(). Resolves every idle waiter when the count hits 0. */
  leave(): void {
    if (this.count <= 0) throw new Error('OpTracker: leave() without a matching enter()');
    this.count--;
    if (this.count === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** Resolve the next time the in-flight count reaches 0 (gate untouched). */
  whenIdle(): Promise<void> {
    if (this.count === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Close the gate and wait for the drain; reopen with resume(). The gate
   *  closes SYNCHRONOUSLY at call time (the async keyword only defers the
   *  whenIdle await), and pause is reference-counted: overlapping pausers all
   *  drain and the gate reopens only when the last one resumes. The drain
   *  completion is the caller's quiescence point. */
  async pause(): Promise<void> {
    this.pausers++;
    this.open = false;
    await this.whenIdle();
  }

  /** Release one pause(); reopens the gate when the last pauser resumes.
   *  No-op after close() (close is terminal). */
  resume(): void {
    if (this.permanentlyClosed) return;
    if (this.pausers > 0) this.pausers--;
    if (this.pausers === 0) this.open = true;
  }

  /** Permanently close the gate and resolve once drained. Idempotent and
   *  shared: concurrent close() calls await the same drain. */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.permanentlyClosed = true;
      this.open = false;
      this.closePromise = this.whenIdle();
    }
    return this.closePromise;
  }
}
