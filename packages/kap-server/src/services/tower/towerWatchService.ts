import {
  Error2,
  ErrorCodes,
  IWorkspaceService,
  parseTowerActivityLine,
  readTowerLogFrom,
  readTowerProjection,
  watchTower,
  type Scope,
  type TowerActivityEvent,
  type TowerWatchHint,
} from '@moonshot-ai/agent-core-v2';

import type { TowerActivityMessage, TowerStateMessage } from '../../protocol/ws-control';
import { toWireTowerProjection } from '../../routes/tower';
import type { BroadcastTarget } from '../../transport/ws/v1/sessionEventBroadcaster';

interface TowerWatchSubscription {
  readonly target: BroadcastTarget;
  logOffset: number;
  queue: Promise<void>;
}

interface TowerWatchEntry {
  readonly root: string;
  readonly targets: Map<BroadcastTarget, TowerWatchSubscription>;
  readonly disposeWatch: () => void;
}

export class TowerWatchService {
  private readonly entries = new Map<string, TowerWatchEntry>();
  private disposed = false;

  constructor(private readonly core: Scope) {}

  async subscribe(
    workspaceId: string,
    target: BroadcastTarget,
    accepted: () => void,
  ): Promise<void> {
    if (this.disposed) return;
    let entry = this.entries.get(workspaceId);
    if (entry === undefined) {
      const workspace = await this.core.accessor.get(IWorkspaceService).get(workspaceId);
      if (this.disposed) return;
      if (workspace === undefined) {
        throw new Error2(
          ErrorCodes.WORKSPACE_NOT_FOUND,
          `workspace ${workspaceId} does not exist`,
        );
      }
      entry = this.entries.get(workspaceId);
      if (entry === undefined) {
        const created: TowerWatchEntry = {
          root: workspace.root,
          targets: new Map(),
          disposeWatch: watchTower(workspace.root, (hint) => {
            this.onHint(workspaceId, hint);
          }),
        };
        this.entries.set(workspaceId, created);
        entry = created;
      }
    }
    const current = entry;
    const subscription: TowerWatchSubscription = {
      target,
      logOffset: 0,
      queue: Promise.resolve(),
    };
    current.targets.set(target, subscription);
    try {
      await this.enqueue(subscription, async () => {
        if (!this.isCurrent(workspaceId, current, subscription)) return;
        const projection = await readTowerProjection(current.root);
        if (!this.isCurrent(workspaceId, current, subscription)) return;
        subscription.logOffset = projection.logOffset;
        accepted();
        this.send(target, {
          type: 'tower.state',
          timestamp: new Date().toISOString(),
          payload: {
            workspace_id: workspaceId,
            ...toWireTowerProjection(projection),
          },
        });
      });
    } catch (error) {
      this.removeSubscription(workspaceId, current, subscription);
      throw error;
    }
  }

  unsubscribe(workspaceId: string, target: BroadcastTarget): void {
    const entry = this.entries.get(workspaceId);
    if (entry === undefined) return;
    entry.targets.delete(target);
    if (entry.targets.size > 0) return;
    entry.disposeWatch();
    this.entries.delete(workspaceId);
  }

  removeTarget(target: BroadcastTarget): void {
    for (const [workspaceId, entry] of this.entries) {
      if (!entry.targets.delete(target)) continue;
      if (entry.targets.size > 0) continue;
      entry.disposeWatch();
      this.entries.delete(workspaceId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) entry.disposeWatch();
    this.entries.clear();
  }

  private isCurrent(
    workspaceId: string,
    entry: TowerWatchEntry,
    subscription: TowerWatchSubscription,
  ): boolean {
    return (
      !this.disposed &&
      this.entries.get(workspaceId) === entry &&
      entry.targets.get(subscription.target) === subscription
    );
  }

  private removeSubscription(
    workspaceId: string,
    entry: TowerWatchEntry,
    subscription: TowerWatchSubscription,
  ): void {
    if (!this.isCurrent(workspaceId, entry, subscription)) return;
    entry.targets.delete(subscription.target);
    if (entry.targets.size > 0) return;
    entry.disposeWatch();
    this.entries.delete(workspaceId);
  }

  private onHint(workspaceId: string, hint: TowerWatchHint): void {
    if (this.disposed) return;
    const entry = this.entries.get(workspaceId);
    if (entry === undefined) return;
    for (const subscription of entry.targets.values()) {
      void this.enqueue(subscription, () =>
        this.handleHint(workspaceId, entry, subscription, hint),
      ).catch(() => {});
    }
  }

  private async handleHint(
    workspaceId: string,
    entry: TowerWatchEntry,
    subscription: TowerWatchSubscription,
    hint: TowerWatchHint,
  ): Promise<void> {
    if (hint.logAppended) await this.emitActivity(workspaceId, entry, subscription);
    if (hint.stateChanged) await this.emitState(workspaceId, entry, subscription);
  }

  private async emitActivity(
    workspaceId: string,
    entry: TowerWatchEntry,
    subscription: TowerWatchSubscription,
  ): Promise<void> {
    let events: TowerActivityEvent[];
    let offset: number;
    try {
      const slice = await readTowerLogFrom(entry.root, subscription.logOffset);
      events = slice.lines
        .map(parseTowerActivityLine)
        .filter((event): event is TowerActivityEvent => event !== undefined);
      offset = slice.offset;
    } catch {
      return;
    }
    if (!this.isCurrent(workspaceId, entry, subscription)) return;
    subscription.logOffset = offset;
    if (events.length === 0) return;
    this.send(subscription.target, {
      type: 'tower.activity',
      timestamp: new Date().toISOString(),
      payload: { workspace_id: workspaceId, events, offset },
    });
  }

  private async emitState(
    workspaceId: string,
    entry: TowerWatchEntry,
    subscription: TowerWatchSubscription,
  ): Promise<void> {
    let frame: TowerStateMessage;
    try {
      const projection = await readTowerProjection(entry.root);
      frame = {
        type: 'tower.state',
        timestamp: new Date().toISOString(),
        payload: {
          workspace_id: workspaceId,
          ...toWireTowerProjection(projection),
        },
      };
    } catch {
      return;
    }
    if (!this.isCurrent(workspaceId, entry, subscription)) return;
    this.send(subscription.target, frame);
  }

  private send(target: BroadcastTarget, frame: TowerStateMessage | TowerActivityMessage): void {
    try {
      target.send(frame);
    } catch {}
  }

  private enqueue(
    subscription: TowerWatchSubscription,
    task: () => Promise<void>,
  ): Promise<void> {
    const run = subscription.queue.then(task);
    subscription.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
