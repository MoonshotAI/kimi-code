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

interface TowerWatchEntry {
  readonly root: string;
  readonly targets: Set<BroadcastTarget>;
  readonly disposeWatch: () => void;
  logOffset: number;
  queue: Promise<void>;
}

export class TowerWatchService {
  private readonly entries = new Map<string, TowerWatchEntry>();
  private disposed = false;

  constructor(private readonly core: Scope) {}

  async subscribe(workspaceId: string, target: BroadcastTarget): Promise<void> {
    if (this.disposed) return;
    let entry = this.entries.get(workspaceId);
    let isFirst = false;
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
        isFirst = true;
        const created: TowerWatchEntry = {
          root: workspace.root,
          targets: new Set(),
          disposeWatch: watchTower(workspace.root, (hint) => {
            this.onHint(workspaceId, hint);
          }),
          logOffset: 0,
          queue: Promise.resolve(),
        };
        this.entries.set(workspaceId, created);
        entry = created;
      }
    }
    entry.targets.add(target);
    const current = entry;
    void this.enqueue(current, async () => {
      if (!current.targets.has(target)) return;
      const projection = await readTowerProjection(current.root);
      if (isFirst) current.logOffset = projection.logOffset;
      this.send(target, {
        type: 'tower.state',
        timestamp: new Date().toISOString(),
        payload: {
          workspace_id: workspaceId,
          ...toWireTowerProjection(projection),
        },
      });
    }).catch(() => {
    });
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

  private onHint(workspaceId: string, hint: TowerWatchHint): void {
    if (this.disposed) return;
    const entry = this.entries.get(workspaceId);
    if (entry === undefined) return;
    void this.enqueue(entry, () => this.handleHint(workspaceId, entry, hint)).catch(() => {
    });
  }

  private async handleHint(
    workspaceId: string,
    entry: TowerWatchEntry,
    hint: TowerWatchHint,
  ): Promise<void> {
    if (hint.logAppended) await this.emitActivity(workspaceId, entry);
    if (hint.stateChanged) await this.emitState(workspaceId, entry);
  }

  private async emitActivity(workspaceId: string, entry: TowerWatchEntry): Promise<void> {
    let events: TowerActivityEvent[];
    let offset: number;
    try {
      const slice = await readTowerLogFrom(entry.root, entry.logOffset);
      events = slice.lines
        .map(parseTowerActivityLine)
        .filter((event): event is TowerActivityEvent => event !== undefined);
      offset = slice.offset;
    } catch {
      return;
    }
    entry.logOffset = offset;
    if (events.length === 0) return;
    this.broadcast(entry, {
      type: 'tower.activity',
      timestamp: new Date().toISOString(),
      payload: { workspace_id: workspaceId, events, offset },
    });
  }

  private async emitState(workspaceId: string, entry: TowerWatchEntry): Promise<void> {
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
    this.broadcast(entry, frame);
  }

  private broadcast(entry: TowerWatchEntry, frame: TowerStateMessage | TowerActivityMessage): void {
    for (const target of entry.targets) this.send(target, frame);
  }

  private send(target: BroadcastTarget, frame: TowerStateMessage | TowerActivityMessage): void {
    try {
      target.send(frame);
    } catch {
    }
  }

  private enqueue(entry: TowerWatchEntry, task: () => Promise<void>): Promise<void> {
    const run = entry.queue.then(task);
    entry.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
