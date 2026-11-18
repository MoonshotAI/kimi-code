import type { TurnEndedEvent, TurnStartedEvent } from '@moonshot-ai/kimi-code-sdk';

import { MAIN_AGENT_ID } from '../constant/kimi-tui';

import { isPromptQueuedMessage, type QueuedMessage } from '../types';

export type StagingLeaseOrigin = 'user' | 'skill_activation' | 'plugin_command';

export interface StagingLease {
  readonly mediaAttachmentIds: readonly number[];
  readonly paths: readonly string[];
  readonly origin: StagingLeaseOrigin;
  readonly agentId: string;
  readonly submissionId?: string;
  turnId: string | undefined;
  released: boolean;
}

export interface StagingLeaseEffects {
  readonly takeFileIds: (mediaAttachmentIds: readonly number[]) => readonly string[];
  readonly releaseRetains: (mediaAttachmentIds: readonly number[]) => void;
  readonly deleteFiles: (fileIds: readonly string[], paths: readonly string[]) => Promise<void>;
  readonly warn?: (message: string) => void;
}

export class StagingLeaseTracker {
  private readonly cleanups = new Set<Promise<void>>();
  private readonly leases = new Set<StagingLease>();
  private readonly leasesByTurn = new Map<string, Set<StagingLease>>();
  private readonly leasesBySubmissionId = new Map<string, StagingLease>();
  private readonly inFlight = new Set<StagingLease>();
  private readonly endedInFlight = new Set<StagingLease>();
  private readonly retiredPaths = new Set<string>();

  constructor(private readonly effects: StagingLeaseEffects) {}

  create(
    mediaAttachmentIds: readonly number[],
    paths: readonly string[],
    origin: StagingLeaseOrigin,
    submissionId?: string,
    agentId = MAIN_AGENT_ID,
  ): StagingLease | undefined {
    if (mediaAttachmentIds.length === 0 && paths.length === 0) return undefined;
    const lease: StagingLease = {
      mediaAttachmentIds: [...mediaAttachmentIds],
      paths: [...paths],
      origin,
      agentId,
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
    const key = `${lease.agentId}:${turnId}`;
    let leases = this.leasesByTurn.get(key);
    if (leases === undefined) {
      leases = new Set<StagingLease>();
      this.leasesByTurn.set(key, leases);
    }
    leases.add(lease);
  }

  handleTurnStarted(event: TurnStartedEvent, agentId = MAIN_AGENT_ID): void {
    const kind = event.origin?.kind;
    if (kind !== 'user' && kind !== 'skill_activation' && kind !== 'plugin_command') return;
    if (event.promptId !== undefined) {
      const exact = this.leasesBySubmissionId.get(event.promptId);
      if (exact !== undefined && exact.turnId === undefined && exact.agentId === agentId) {
        this.bindToTurn(exact, String(event.turnId));
        return;
      }
    }
    const candidates = [...this.leases].filter(
      (candidate) =>
        !candidate.released && candidate.turnId === undefined &&
        candidate.origin === kind && candidate.agentId === agentId,
    );
    if (candidates.length > 1) {
      this.effects.warn?.(
        `staging lease: ${candidates.length} unclaimed '${kind}' leases when turn ` +
          `${String(event.turnId)} started; claiming the earliest`,
      );
    }
    this.bindToTurn(candidates[0], String(event.turnId));
  }

  handleTurnEnded(event: TurnEndedEvent, agentId = MAIN_AGENT_ID): void {
    const key = `${agentId}:${String(event.turnId)}`;
    const leases = this.leasesByTurn.get(key);
    if (leases === undefined) return;
    for (const lease of leases) {
      if (this.inFlight.has(lease)) {
        this.endedInFlight.add(lease);
        continue;
      }
      this.releaseConsumed(lease);
    }
    if (this.leasesByTurn.get(key)?.size === 0) this.leasesByTurn.delete(key);
  }

  trackDispatch(
    lease: StagingLease | undefined,
    request: Promise<unknown>,
    onError: (error: unknown) => void,
  ): void {
    if (lease !== undefined) this.inFlight.add(lease);
    this.track(
      request.then(
        () => {
          this.settleInFlight(lease, true);
        },
        (error: unknown) => {
          onError(error);
          if (lease?.turnId === undefined) this.release(lease);
          this.settleInFlight(lease, false);
        },
      ),
    );
  }

  private settleInFlight(lease: StagingLease | undefined, consumed: boolean): void {
    if (lease === undefined) return;
    this.inFlight.delete(lease);
    if (!this.endedInFlight.delete(lease)) return;
    if (consumed) this.releaseConsumed(lease);
    else this.release(lease);
  }

  release(lease: StagingLease | undefined): void {
    if (lease === undefined || lease.released) return;
    this.unbind(lease);
    this.deleteStaged(this.takeFileIds(lease), lease.paths);
  }

  releaseAll(): void {
    for (const lease of this.leases) this.release(lease);
    const retired = [...this.retiredPaths];
    this.retiredPaths.clear();
    this.deleteStaged([], retired);
  }

  releaseMedia(mediaAttachmentIds: readonly number[], paths: readonly string[]): void {
    const fileIds = this.effects.takeFileIds(mediaAttachmentIds);
    this.deleteStaged(fileIds, paths);
  }

  releaseQueued(items: readonly QueuedMessage[]): void {
    const fileIds = items.filter(isPromptQueuedMessage).flatMap((item) =>
      this.effects.takeFileIds([
        ...(item.imageAttachmentIds ?? []),
        ...(item.videoAttachmentIds ?? []),
      ]),
    );
    this.deleteStaged(fileIds, []);
  }

  releaseRecalled(
    mediaAttachmentIds: readonly number[],
    retirePaths: readonly string[] = [],
  ): void {
    this.effects.releaseRetains(mediaAttachmentIds);
    for (const path of retirePaths) this.retiredPaths.add(path);
  }

  defer(lease: StagingLease | undefined): void {
    if (lease === undefined || lease.released) return;
    this.unbind(lease);
  }

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

  deleteStaged(fileIds: readonly string[], paths: readonly string[] = []): void {
    if (fileIds.length === 0 && paths.length === 0) return;
    this.track(this.effects.deleteFiles(fileIds, paths));
  }

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
      const key = `${lease.agentId}:${lease.turnId}`;
      const leases = this.leasesByTurn.get(key);
      leases?.delete(lease);
      if (leases?.size === 0) this.leasesByTurn.delete(key);
    }
  }

  private takeFileIds(lease: StagingLease): readonly string[] {
    return lease.mediaAttachmentIds.flatMap((id) => this.effects.takeFileIds([id]));
  }
}
