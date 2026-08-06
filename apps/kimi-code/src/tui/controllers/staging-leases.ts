/**
 * `StagingLeaseTracker` — owns the lifecycle of staged prompt media (daemon
 * uploads + local cache copies) between submission and the turn that consumes
 * it.
 *
 * A paste/upload edge stages media before the prompt exists; the engine
 * materializes its own session copy at intake, so the staged copies become
 * garbage once the consuming turn ends. The tracker holds one lease per
 * submission, binds it to the consuming turn (explicitly at dispatch, or
 * heuristically when a matching-origin turn starts), and releases the staged
 * files when that turn ends. Unclaimed leases are released at session close /
 * shutdown, and every in-flight cleanup is drainable via {@link drain}.
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
  turnId: string | undefined;
  released: boolean;
}

export interface StagingLeaseEffects {
  /** Resolve attachment ids to the staged daemon file ids, consuming the mapping. */
  readonly takeFileIds: (imageAttachmentIds: readonly number[]) => readonly string[];
  /** Delete staged files (daemon uploads + local cache copies); never rejects. */
  readonly deleteFiles: (fileIds: readonly string[], paths: readonly string[]) => Promise<void>;
}

export class StagingLeaseTracker {
  private readonly cleanups = new Set<Promise<void>>();
  /** Staged media is owned by the turn that consumes it, not by the RPC call. */
  private readonly leases = new Set<StagingLease>();
  private readonly leasesByTurn = new Map<string, Set<StagingLease>>();

  constructor(private readonly effects: StagingLeaseEffects) {}

  create(
    imageAttachmentIds: readonly number[],
    paths: readonly string[],
    origin: StagingLeaseOrigin,
  ): StagingLease | undefined {
    if (imageAttachmentIds.length === 0 && paths.length === 0) return undefined;
    const lease: StagingLease = {
      imageAttachmentIds: [...imageAttachmentIds],
      paths: [...paths],
      origin,
      turnId: undefined,
      released: false,
    };
    this.leases.add(lease);
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
    const lease = [...this.leases].find(
      (candidate) =>
        !candidate.released && candidate.turnId === undefined && candidate.origin === kind,
    );
    this.bindToTurn(lease, String(event.turnId));
  }

  handleTurnEnded(event: TurnEndedEvent): void {
    const turnId = String(event.turnId);
    const leases = this.leasesByTurn.get(turnId);
    if (leases === undefined) return;
    for (const lease of leases) this.release(lease);
    this.leasesByTurn.delete(turnId);
  }

  release(lease: StagingLease | undefined): void {
    if (lease === undefined || lease.released) return;
    lease.released = true;
    this.leases.delete(lease);
    if (lease.turnId !== undefined) {
      const leases = this.leasesByTurn.get(lease.turnId);
      leases?.delete(lease);
      if (leases?.size === 0) this.leasesByTurn.delete(lease.turnId);
    }
    const fileIds = lease.imageAttachmentIds.flatMap((id) => this.effects.takeFileIds([id]));
    this.scheduleDelete(fileIds, lease.paths);
  }

  releaseAll(): void {
    for (const lease of this.leases) this.release(lease);
  }

  /** Release staged media that never got a lease (validation/render failures). */
  releaseMedia(imageAttachmentIds: readonly number[], paths: readonly string[]): void {
    const fileIds = this.effects.takeFileIds(imageAttachmentIds);
    this.scheduleDelete(fileIds, paths);
  }

  releaseQueued(items: readonly QueuedMessage[]): void {
    const fileIds = items.flatMap((item) =>
      this.effects.takeFileIds(item.imageAttachmentIds ?? []),
    );
    const paths = items.flatMap((item) => item.stagingPaths ?? []);
    this.scheduleDelete(fileIds, paths);
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

  private scheduleDelete(fileIds: readonly string[], paths: readonly string[] = []): void {
    this.deleteStaged(fileIds, paths);
  }
}
