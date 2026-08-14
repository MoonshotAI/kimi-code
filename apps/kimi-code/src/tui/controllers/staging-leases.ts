/**
 * `StagingLeaseTracker` — owns the lifecycle of staged prompt media (daemon
 * uploads + local cache copies) between submission and the session that
 * consumes it.
 *
 * A paste/upload edge stages media before the prompt exists. The two staged
 * forms age differently once the consuming turn ends:
 *
 * - Daemon uploads become garbage — the engine materialized its own session
 *   copy at intake — so the turn-end release deletes them.
 * - Local cache copies may still be referenced by persisted history: a v1
 *   video degrade writes its `<video path="…">` tag with the cache path, and
 *   skill/plugin args carry the path as plain text; neither form is rewritten
 *   to the session media dir. Turn-end release therefore retires cache copies
 *   to a session-lifetime bucket, deleted at session close / shutdown.
 *
 * Media that never gets consumed (validation/render failure, queue discard,
 * a dispatch RPC that failed before any turn claimed the lease) is deleted
 * immediately, whatever form it takes.
 *
 * A submission diverted before dispatch hands its lease back via `defer`:
 * the media stays staged under raw (ids, paths) ownership — a queued message
 * re-leases at dequeue dispatch, and the cache-hint stash's restore/resend
 * exits release it through `releaseRecalled` / a fresh lease.
 *
 * The tracker holds one lease per submission, binds it to the consuming turn
 * (explicitly at dispatch, by exact submission id when the turn echoes the
 * client-chosen prompt id, or heuristically when a matching-origin turn
 * starts), and releases it when that turn ends. The heuristic claims the
 * earliest unclaimed lease of the same origin; that is only sound because the
 * TUI serializes same-origin dispatches (one in-flight submission at a time,
 * see `beginSessionRequest`) and `turn.started` arrives in dispatch order.
 *
 * Exact binding: a lease created with a `submissionId` is registered in
 * `leasesBySubmissionId`, and the submission sends that id as the prompt id;
 * the consuming turn's `turn.started` echoes it as `promptId`, so
 * `handleTurnStarted` binds the exact lease instead of guessing. The
 * heuristic below remains the fallback for submissions without an id echo.
 *
 * INVARIANT: at most one unclaimed lease per origin at any moment — with two
 * or more, the heuristic cannot tell which submission the turn belongs to.
 * `handleTurnStarted` reports a violation through the `warn` effect and still
 * claims the earliest (a mis-claim only mis-times deletions, so it is not
 * worth failing the turn over). An exact `promptId` hit bypasses the
 * heuristic entirely, so it neither trips nor needs the invariant.
 *
 * Unclaimed leases are released at session close / shutdown, and every
 * in-flight cleanup is drainable via {@link drain}.
 *
 * Self-contained state machine extracted from `KimiTUI`: the two side effects
 * (resolving attachment ids to daemon file ids, deleting the staged files)
 * are injected, so the tracker is unit-testable without a TUI.
 */

import type { TurnEndedEvent, TurnStartedEvent } from '@moonshot-ai/kimi-code-sdk';

import type { QueuedMessage } from '../types';

export type StagingLeaseOrigin = 'user' | 'skill_activation' | 'plugin_command';

export interface StagingLease {
  readonly imageAttachmentIds: readonly number[];
  readonly paths: readonly string[];
  readonly origin: StagingLeaseOrigin;
  readonly submissionId?: string;
  turnId: string | undefined;
  released: boolean;
}

export interface StagingLeaseEffects {
  /** Resolve attachment ids to the staged daemon file ids, consuming the mapping. */
  readonly takeFileIds: (imageAttachmentIds: readonly number[]) => readonly string[];
  /** Consume retains without taking the staged files (queue recall keeps them). */
  readonly releaseRetains: (imageAttachmentIds: readonly number[]) => void;
  /** Delete staged files (daemon uploads + local cache copies); never rejects. */
  readonly deleteFiles: (fileIds: readonly string[], paths: readonly string[]) => Promise<void>;
  /**
   * Optional sink for invariant violations (see the INVARIANT note above).
   * The tracker keeps operating; the warning exists to make a broken
   * same-origin ordering assumption visible instead of mis-binding silently.
   */
  readonly warn?: (message: string) => void;
}

export class StagingLeaseTracker {
  private readonly cleanups = new Set<Promise<void>>();
  /** Staged media is owned by the turn that consumes it, not by the RPC call. */
  private readonly leases = new Set<StagingLease>();
  private readonly leasesByTurn = new Map<string, Set<StagingLease>>();
  /** Leases carrying a client-chosen submission id, for exact `promptId` binding. */
  private readonly leasesBySubmissionId = new Map<string, StagingLease>();
  /**
   * Cache copies whose consuming turn already ended. Persisted history may
   * still reference their paths (v1 video degrade tags, skill/plugin text
   * references), so they survive until the session closes.
   */
  private readonly retiredPaths = new Set<string>();

  constructor(private readonly effects: StagingLeaseEffects) {}

  create(
    imageAttachmentIds: readonly number[],
    paths: readonly string[],
    origin: StagingLeaseOrigin,
    submissionId?: string,
  ): StagingLease | undefined {
    // `imageAttachmentIds` multiplicity is the retain count this lease must
    // release: each extraction/rewrite retains once per unique id, so callers
    // dedupe repeated placeholder occurrences per contribution before handing
    // the ids over (one message referencing an image twice contributes it
    // once; two batched messages sharing an image contribute it twice).
    if (imageAttachmentIds.length === 0 && paths.length === 0) return undefined;
    const lease: StagingLease = {
      imageAttachmentIds: [...imageAttachmentIds],
      paths: [...paths],
      origin,
      submissionId,
      turnId: undefined,
      released: false,
    };
    this.leases.add(lease);
    if (submissionId !== undefined) this.leasesBySubmissionId.set(submissionId, lease);
    return lease;
  }

  bindToTurn(lease: StagingLease | undefined, turnId: string): void {
    if (lease === undefined || lease.released || lease.turnId !== undefined) return;
    lease.turnId = turnId;
    let leases = this.leasesByTurn.get(turnId);
    if (leases === undefined) {
      leases = new Set<StagingLease>();
      this.leasesByTurn.set(turnId, leases);
    }
    leases.add(lease);
  }

  handleTurnStarted(event: TurnStartedEvent): void {
    const kind = event.origin?.kind;
    if (kind !== 'user' && kind !== 'skill_activation' && kind !== 'plugin_command') return;
    if (event.promptId !== undefined) {
      // Exact binding: the turn echoes the submission's client-chosen prompt
      // id — bind that lease directly and skip the origin heuristic (and its
      // ambiguity warning) entirely.
      const exact = this.leasesBySubmissionId.get(event.promptId);
      if (exact !== undefined && exact.turnId === undefined) {
        this.bindToTurn(exact, String(event.turnId));
        return;
      }
    }
    const candidates = [...this.leases].filter(
      (candidate) =>
        !candidate.released && candidate.turnId === undefined && candidate.origin === kind,
    );
    if (candidates.length > 1) {
      // INVARIANT violation: the earliest-unclaimed pick cannot tell
      // same-origin leases apart — same-origin dispatch serialization or the
      // turn.started ordering assumption may be broken.
      this.effects.warn?.(
        `staging lease: ${candidates.length} unclaimed '${kind}' leases when turn ` +
          `${String(event.turnId)} started; claiming the earliest`,
      );
    }
    this.bindToTurn(candidates[0], String(event.turnId));
  }

  handleTurnEnded(event: TurnEndedEvent): void {
    const turnId = String(event.turnId);
    const leases = this.leasesByTurn.get(turnId);
    if (leases === undefined) return;
    for (const lease of leases) this.releaseConsumed(lease);
    this.leasesByTurn.delete(turnId);
  }

  /**
   * Track a dispatch RPC carrying staged media. When it rejects, run
   * `onError` and release the lease — but only while no turn has claimed it:
   * a bound lease is owned by the turn and released at turn end, whatever the
   * RPC's later outcome.
   */
  trackDispatch(
    lease: StagingLease | undefined,
    request: Promise<unknown>,
    onError: (error: unknown) => void,
  ): void {
    this.track(
      request
        .catch((error: unknown) => {
          onError(error);
          if (lease?.turnId === undefined) this.release(lease);
        })
        .then(() => undefined),
    );
  }

  /**
   * Release staged media that will never be consumed (dispatch failed before
   * a turn claimed the lease): delete daemon uploads and cache copies now.
   */
  release(lease: StagingLease | undefined): void {
    if (lease === undefined || lease.released) return;
    this.unbind(lease);
    this.deleteStaged(this.takeFileIds(lease), lease.paths);
  }

  /** Release every unclaimed lease and the retired cache copies (session close / shutdown). */
  releaseAll(): void {
    for (const lease of this.leases) this.release(lease);
    const retired = [...this.retiredPaths];
    this.retiredPaths.clear();
    this.deleteStaged([], retired);
  }

  /** Release staged media that never got a lease (validation/render failures). */
  releaseMedia(imageAttachmentIds: readonly number[], paths: readonly string[]): void {
    const fileIds = this.effects.takeFileIds(imageAttachmentIds);
    this.deleteStaged(fileIds, paths);
  }

  releaseQueued(items: readonly QueuedMessage[]): void {
    const fileIds = items.flatMap((item) =>
      this.effects.takeFileIds(item.imageAttachmentIds ?? []),
    );
    const paths = items.flatMap((item) => item.stagingPaths ?? []);
    this.deleteStaged(fileIds, paths);
  }

  /**
   * Release a queued item (or a cache-hint stash's extraction) recalled into
   * the editor: the restored draft still references its attachments, so this
   * is not a discard — daemon uploads stay staged (only the retain is
   * consumed; the next submit re-retains them) and cache copies retire to
   * session lifetime instead of being deleted.
   */
  releaseRecalled(item: {
    imageAttachmentIds?: readonly number[];
    stagingPaths?: readonly string[];
  }): void {
    this.effects.releaseRetains(item.imageAttachmentIds ?? []);
    for (const path of item.stagingPaths ?? []) this.retiredPaths.add(path);
  }

  /**
   * Hand a lease's staged media back to raw (ids, paths) ownership without
   * consuming retains or deleting files: the lease is simply unbound. Used
   * when a submission is diverted before dispatch — queued behind a running
   * turn or swallowed by the cache-hint stash; see the header note.
   */
  defer(lease: StagingLease | undefined): void {
    if (lease === undefined || lease.released) return;
    this.unbind(lease);
  }

  /** Track an in-flight staging-related promise so {@link drain} can await it. */
  track(cleanup: Promise<void>): void {
    let tracked!: Promise<void>;
    tracked = cleanup.catch(() => undefined).finally(() => {
      this.cleanups.delete(tracked);
    });
    this.cleanups.add(tracked);
  }

  async drain(): Promise<void> {
    while (this.cleanups.size > 0) {
      await Promise.allSettled(this.cleanups);
    }
  }

  /** Schedule deletion of already-resolved staged files (e.g. a store clear). */
  deleteStaged(fileIds: readonly string[], paths: readonly string[] = []): void {
    if (fileIds.length === 0 && paths.length === 0) return;
    this.track(this.effects.deleteFiles(fileIds, paths));
  }

  /**
   * Turn-end release: the daemon uploads are safe to delete — the engine
   * materialized its own session copies at intake — while the cache copies
   * retire to session lifetime (see {@link retiredPaths}).
   */
  private releaseConsumed(lease: StagingLease): void {
    if (lease.released) return;
    this.unbind(lease);
    for (const path of lease.paths) this.retiredPaths.add(path);
    this.deleteStaged(this.takeFileIds(lease));
  }

  private unbind(lease: StagingLease): void {
    lease.released = true;
    this.leases.delete(lease);
    if (lease.submissionId !== undefined) this.leasesBySubmissionId.delete(lease.submissionId);
    if (lease.turnId !== undefined) {
      const leases = this.leasesByTurn.get(lease.turnId);
      leases?.delete(lease);
      if (leases?.size === 0) this.leasesByTurn.delete(lease.turnId);
    }
  }

  private takeFileIds(lease: StagingLease): readonly string[] {
    // Multiplicity in the lease's id list is the retain count (creation sites
    // dedupe per extraction before contributing ids): consume one retain per
    // occurrence.
    return lease.imageAttachmentIds.flatMap((id) => this.effects.takeFileIds([id]));
  }
}
