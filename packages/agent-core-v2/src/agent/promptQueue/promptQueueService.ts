import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, type PromptHandle } from '#/agent/loop/loop';
import { WarningIssued } from '#/agent/profile/profileOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventService } from '#/app/event/event';
import { LifecycleScope } from '#/app/scopes';
import { ISessionRunGate } from '#/session/sessionActivity/sessionRunGate';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { Error2, ErrorCodes } from '#/errors';
import type { UserEntry } from '#human/agent/turn';

import {
  IAgentPromptQueueService,
  type PromptQueueCompactionRequest,
  type PromptQueueInputRequest,
  type PromptQueueSnapshot,
  type PromptQueueSubmitResult,
  type QueuedPromptItem,
} from './promptQueue';
import { PromptQueueChanged } from './promptQueueEvents';

type QueueEntry = QueuedPromptItem & {
  readonly prepare?: () => Promise<void>;
  readonly onDrop?: () => void;
};

export class AgentPromptQueueService extends Disposable implements IAgentPromptQueueService {
  declare readonly _serviceBrand: undefined;

  private readonly onDidChangeEmitter = this._register(new Emitter<PromptQueueSnapshot>());
  readonly onDidChange = this.onDidChangeEmitter.event;

  private entries: QueueEntry[] = [];
  private paused = false;
  private busy = false;
  private pumpScheduled = false;
  private disposed = false;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentFullCompactionService private readonly compaction: IAgentFullCompactionService,
    @IEventService private readonly events: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ISessionRunGate private readonly runGate: ISessionRunGate,
    @ILogService private readonly logger: ILogService,
  ) {
    super();
    this._register(this.loop.onDidChangeActivity(() => {
      this.schedulePump();
    }));
  }

  snapshot(): PromptQueueSnapshot {
    return {
      paused: this.paused,
      items: this.entries.map(({ prepare: _prepare, onDrop: _onDrop, ...item }) => item),
    };
  }

  hasPendingInputs(): boolean {
    return !this.paused && this.entries.some((item) => item.kind === 'input');
  }

  hasPendingItems(): boolean {
    return !this.paused && this.entries.length > 0;
  }

  async submitInput(request: PromptQueueInputRequest): Promise<PromptQueueSubmitResult> {
    this.assertOpen();
    this.assertNewId(request.id);
    if (request.mode !== undefined && request.delivery === 'steer') {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'a prompt with a mode cannot be steered');
    }
    if (request.delivery === 'steer' && !this.paused && !this.busy && this.loop.canSteerPrompt()) {
      return { acceptedAs: 'steer', handle: await this.handOffSteer(request.entry) };
    }
    const entry: QueueEntry = {
      kind: 'input',
      id: request.id,
      delivery: request.delivery,
      entry: request.entry,
      mode: request.mode,
      createdAt: request.entry.meta?.createdAt ?? new Date().toISOString(),
      prepare: request.prepare,
      onDrop: request.onDrop,
    };
    if (!this.canStartNow()) {
      this.insert(entry);
      return { acceptedAs: request.delivery };
    }
    if (request.prepare === undefined) {
      return { acceptedAs: 'turn', handle: this.launch(request.entry) };
    }
    this.busy = true;
    try {
      this.runGate.begin();
      await request.prepare();
      this.assertOpen();
      if (this.loop.canLaunchPrompt()) {
        return { acceptedAs: 'turn', handle: this.launch(request.entry) };
      }
      this.restoreAtHead({ ...entry, prepare: undefined });
      this.emitChange();
      return { acceptedAs: 'queue' };
    } finally {
      this.busy = false;
      this.schedulePump();
    }
  }

  submitCompaction(request: PromptQueueCompactionRequest): PromptQueueSubmitResult {
    this.assertOpen();
    this.assertNewId(request.id);
    if (this.canStartNow()) {
      this.startCompaction(request.instruction);
      return { acceptedAs: 'compact' };
    }
    this.insert({
      kind: 'compact',
      id: request.id,
      delivery: 'queue',
      instruction: request.instruction,
      createdAt: new Date().toISOString(),
    });
    return { acceptedAs: 'queue' };
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.emitChange();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.emitChange();
    this.schedulePump();
  }

  steer(id: string): void {
    const entry = this.find(id);
    if (entry.kind !== 'input') {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'only an input can be steered');
    }
    if (entry.mode !== undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'a prompt with a mode cannot be steered');
    }
    if (entry.delivery === 'steer') return;
    this.entries = this.entries.filter((item) => item !== entry);
    this.insert({ ...entry, delivery: 'steer' });
  }

  move(id: string, beforeId?: string): void {
    const entry = this.find(id);
    if (entry.delivery === 'steer') {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'steers keep their order ahead of queued prompts');
    }
    if (beforeId === id) return;
    const before = beforeId === undefined ? undefined : this.find(beforeId);
    if (before?.delivery === 'steer') {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'queued prompts cannot move ahead of steers');
    }
    const rest = this.entries.filter((item) => item !== entry);
    const index = before === undefined ? rest.length : rest.indexOf(before);
    rest.splice(index, 0, entry);
    this.entries = rest;
    this.emitChange();
    this.schedulePump();
  }

  cancel(id: string): void {
    const entry = this.find(id);
    this.entries = this.entries.filter((item) => item !== entry);
    this.emitChange();
    entry.onDrop?.();
  }

  override dispose(): void {
    this.disposed = true;
    const dropped = this.entries;
    this.entries = [];
    for (const entry of dropped) entry.onDrop?.();
    super.dispose();
  }

  private canStartNow(): boolean {
    return (
      !this.busy &&
      (this.paused || this.entries.length === 0) &&
      this.loop.canLaunchPrompt()
    );
  }

  private insert(entry: QueueEntry): void {
    if (entry.delivery === 'steer') {
      const firstQueued = this.entries.findIndex((item) => item.delivery !== 'steer');
      const index = firstQueued === -1 ? this.entries.length : firstQueued;
      this.entries = [...this.entries.slice(0, index), entry, ...this.entries.slice(index)];
    } else {
      this.entries = [...this.entries, entry];
    }
    this.emitChange();
    this.schedulePump();
  }

  private find(id: string): QueueEntry {
    const entry = this.entries.find((item) => item.id === id);
    if (entry === undefined) {
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, `prompt ${id} is not in the queue`);
    }
    return entry;
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error2(ErrorCodes.SESSION_CLOSED, 'the agent was closed before the prompt was accepted');
    }
  }

  private assertNewId(id: string): void {
    if (this.entries.some((item) => item.id === id)) {
      throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, `prompt ${id} is already queued`);
    }
  }

  private emitChange(): void {
    if (this.disposed) return;
    const snapshot = this.snapshot();
    this.onDidChangeEmitter.fire(snapshot);
    this.events.publish(
      new PromptQueueChanged({
        payload: {
          sessionId: this.sessionContext.sessionId,
          agentId: this.scopeContext.agentId,
          snapshot,
        },
      }),
    );
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.disposed) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump().catch((error: unknown) => {
        this.logger.warn('prompt queue failed to advance', { error });
      });
    });
  }

  private async pump(): Promise<void> {
    if (this.disposed || this.paused || this.busy || this.entries.length === 0) return;
    const head = this.entries[0]!;
    if (head.kind === 'input' && head.delivery === 'steer' && this.loop.canSteerPrompt()) {
      await this.runBusy(async () => {
        this.take(head);
        const id = this.submitTaken(head);
        if (id !== undefined) await this.steerSubmitted(id);
      });
      return;
    }
    if (!this.loop.canLaunchPrompt()) return;
    if (head.kind === 'compact') {
      this.take(head);
      this.startQueuedCompaction(head.instruction);
      this.schedulePump();
      return;
    }
    if (head.prepare !== undefined) {
      await this.runBusy(() => this.applyMode(head));
      return;
    }
    this.take(head);
    this.submitTaken(head);
  }

  private async applyMode(entry: QueueEntry): Promise<void> {
    try {
      this.runGate.begin();
      await entry.prepare?.();
    } catch (error) {
      if (this.entries.includes(entry)) this.pauseAfterFailedStart(entry, error);
      return;
    }
    this.entries = this.entries.map((item) => (item === entry ? { ...item, prepare: undefined } : item));
  }

  private async runBusy(run: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await run();
    } finally {
      this.busy = false;
      this.schedulePump();
    }
  }

  private submitTaken(entry: QueueEntry & { readonly kind: 'input' }): string | undefined {
    try {
      return this.loop.submit(entry.entry).id;
    } catch (error) {
      this.restoreAtHead(entry);
      this.pauseAfterFailedStart(entry, error);
      return undefined;
    }
  }

  private pauseAfterFailedStart(entry: QueueEntry, error: unknown): void {
    this.logger.warn('queued prompt could not start', { promptId: entry.id, error });
    this.paused = true;
    this.emitChange();
    this.warn('queued-prompt-failed', `The queue was paused because a queued prompt could not start: ${reasonOf(error)}`);
  }

  private restoreAtHead(entry: QueueEntry): void {
    const firstQueued = this.entries.findIndex((item) => item.delivery !== 'steer');
    const afterSteers = firstQueued === -1 ? this.entries.length : firstQueued;
    const index = entry.delivery === 'steer' ? 0 : afterSteers;
    this.entries = [...this.entries.slice(0, index), entry, ...this.entries.slice(index)];
  }

  private take(entry: QueueEntry): void {
    this.entries = this.entries.filter((item) => item !== entry);
    this.emitChange();
  }

  private launch(entry: UserEntry): PromptHandle | undefined {
    const { id } = this.loop.submit(entry);
    return this.loop.promptHandle(id);
  }

  private async handOffSteer(entry: UserEntry): Promise<PromptHandle | undefined> {
    const { id } = this.loop.submit(entry);
    const handle = this.loop.promptHandle(id);
    await this.steerSubmitted(id);
    return handle;
  }

  private async steerSubmitted(id: string): Promise<void> {
    try {
      await this.loop.steer([id]);
    } catch (error) {
      this.logger.debug('steer fell back to the next turn', { promptId: id, error });
    }
  }

  private startCompaction(instruction: string | undefined): void {
    if (!this.compaction.begin({ source: 'manual', instruction })) {
      throw new Error2(ErrorCodes.COMPACTION_UNABLE, 'A compaction is already running.');
    }
  }

  private startQueuedCompaction(instruction: string | undefined): void {
    try {
      this.startCompaction(instruction);
    } catch (error) {
      this.logger.warn('queued compaction could not start', { error });
      this.warn('queued-compaction-failed', `The queued compaction did not start: ${reasonOf(error)}`);
    }
  }

  private warn(code: string, message: string): void {
    void this.dispatcher.dispatch(new WarningIssued({ agentId: this.scopeContext.agentId, code, message }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptQueueService,
  AgentPromptQueueService,
  ScopeActivation.OnDemand,
  'promptQueue',
);
