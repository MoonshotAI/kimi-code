import { createControlledPromise } from '@antfu/utils';

import type { IEventDispatcher } from '#/state/eventDispatcher';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { stripBundledSkillBlocks } from '@moonshot-ai/core/llm/origin';
import type { Message, UserMessage } from '@moonshot-ai/core/llm/message';
import { newMessageId } from '#/agent/contextMemory/messageId';
import {
  PromptAborted,
  PromptCompleted,
  PromptQueued,
  PromptStarted,
  PromptSteered,
  PromptSubmitted,
} from '#/agent/prompt/promptEvents';
import type { LoopEmitted, TurnStartingEvent, TurnTrigger } from '@moonshot-ai/core/loop/index';
import type { PromptCompletion, PromptHandle, PromptState, Turn, TurnResult } from './loop';

export interface PromptProjection {
  readonly origin: PromptOrigin;
  readonly message: ContextMessage;
  readonly userMessageId: string;
  readonly createdAt: string;
}

export interface ActivePrompt extends PromptProjection {
  readonly id: string;
  readonly promptId?: string;
}

export interface PendingTurn {
  readonly entry: UserMessage;
  readonly waiter?: PromptWaiter;
  readonly trigger: TurnTrigger;
  message: UserMessage;
}

export interface PromptWaiter {
  readonly id: string;
  readonly launched: ReturnType<typeof createControlledPromise<Turn | undefined>>;
  readonly completion: ReturnType<typeof createControlledPromise<PromptCompletion>>;
  submitted?: boolean;
  entry?: UserMessage;
  failedEntry?: UserMessage;
  launchedTurn?: Turn;
  settled?: boolean;
}

interface ActivePromptState extends ActivePrompt {
  readonly steeredPromptIds: Set<string>;
}

const EMPTY_HANDLE_MESSAGE: ContextMessage = { role: 'user', content: [] };

export class AgentPromptProjection {
  private readonly waiters = new Map<string, PromptWaiter>();
  private readonly steered = new Map<string, PromptProjection>();
  private readonly terminalStates = new Map<string, PromptState>();
  private readonly pendingTurns = new Map<number, PendingTurn>();
  private readonly entriesByTurn = new Map<number, UserMessage>();
  private readonly materializedTurnIds = new Map<string, number>();
  private active: ActivePromptState | undefined;

  constructor(
    private readonly dispatcher: IEventDispatcher,
    private readonly agentId: string,
    private readonly queueLength: (includeCurrent: boolean) => number,
  ) {}

  admit(input: UserMessage, queued: boolean): { readonly id: string; readonly entry: UserMessage } {
    const attributes = input.attributes;
    const id = attributes?.promptId ?? newMessageId();
    const origin = (attributes?.origin as PromptOrigin | undefined) ?? { kind: 'user' };
    const entry: UserMessage = {
      role: 'user',
      content: [...input.content],
      attributes: {
        ...attributes,
        promptId: id,
        origin,
        createdAt: attributes?.createdAt ?? new Date().toISOString(),
        userMessageId: attributes?.userMessageId ?? id,
      },
    };
    const waiter = this.createWaiter(id);
    waiter.entry = entry;
    waiter.submitted = true;
    this.terminalStates.delete(id);
    this.steered.delete(id);
    const projection = projectionFromEntry(entry);
    this.publishSubmitted(projection, queued ? 'queued' : 'running');
    if (queued) this.publishQueued(projection, true);
    return { id, entry };
  }

  ensure(entry: UserMessage, queued: boolean): PromptWaiter {
    const id = entry.attributes?.promptId ?? newMessageId();
    const normalized: UserMessage = {
      ...entry,
      attributes: {
        ...entry.attributes,
        promptId: id,
        createdAt: entry.attributes?.createdAt ?? new Date().toISOString(),
        userMessageId: entry.attributes?.userMessageId ?? id,
      },
    };
    const waiter = this.ensureWaiter(id);
    waiter.entry = normalized;
    if (waiter.submitted !== true) {
      const projection = projectionFromEntry(normalized);
      this.publishSubmitted(projection, queued ? 'queued' : 'running');
      if (queued) this.publishQueued(projection, false);
      waiter.submitted = true;
    }
    return waiter;
  }

  handle(id: string): PromptHandle | undefined {
    const waiter = this.waiters.get(id);
    if (waiter === undefined) return undefined;
    const projection = this.projectionOf(id);
    const state = (): PromptState => this.stateOf(id);
    return {
      id,
      userMessageId: projection?.userMessageId ?? '',
      createdAt: projection?.createdAt ?? '',
      get state() {
        return state();
      },
      message: projection?.message ?? EMPTY_HANDLE_MESSAGE,
      launched: waiter.launched,
      completion: waiter.completion,
    };
  }

  private stateOf(id: string): PromptState {
    if (this.active?.id === id || this.active?.steeredPromptIds.has(id) === true) return 'running';
    if (this.steered.has(id)) return 'steered';
    return this.terminalStates.get(id) ?? 'pending';
  }

  activePrompt(): ActivePrompt | undefined {
    return this.active;
  }

  hasPendingTurns(): boolean {
    return this.pendingTurns.size > 0;
  }

  pendingEntries(): readonly UserMessage[] {
    return [...this.pendingTurns.values()].map((pending) => pending.entry);
  }

  pending(turnId: number): PendingTurn | undefined {
    return this.pendingTurns.get(turnId);
  }

  prepareTurn(event: TurnStartingEvent): PendingTurn | undefined {
    const normal = event.pending.find((item) => item.kind === 'normal');
    if (normal === undefined) return undefined;
    const entry = normal.message;
    const waiter = this.ensure(entry, false);
    const pending: PendingTurn = { entry, waiter, trigger: event.trigger, message: entry };
    this.pendingTurns.set(event.turnId, pending);
    return pending;
  }

  activatePending(turnId: number): PendingTurn | undefined {
    const pending = this.pendingTurns.get(turnId);
    this.pendingTurns.delete(turnId);
    return pending;
  }

  activatePromptOnly(event: Extract<LoopEmitted, { type: 'turn.started' }>): PendingTurn | undefined {
    const entry = event.message;
    if (entry === undefined) return undefined;
    const waiter = this.ensure(entry, false);
    const pending: PendingTurn = { entry, waiter, trigger: event.trigger, message: entry };
    this.pendingTurns.set(event.turnId, pending);
    return this.activatePending(event.turnId);
  }

  begin(waiter: PromptWaiter, entry: UserMessage): ActivePrompt {
    waiter.entry = entry;
    const projection = projectionFromEntry(entry);
    const prompt: ActivePromptState = {
      id: waiter.id,
      promptId: waiter.id,
      origin: projection.origin,
      message: projection.message,
      userMessageId: projection.userMessageId,
      createdAt: projection.createdAt,
      steeredPromptIds: new Set(),
    };
    this.active = prompt;
    if (waiter.submitted !== true) {
      this.publishSubmitted(prompt, 'running');
      waiter.submitted = true;
    }
    return prompt;
  }

  launched(waiter: PromptWaiter, turn: Turn): void {
    if (waiter.launchedTurn !== undefined) return;
    waiter.launchedTurn = turn;
    waiter.launched.resolve(turn);
    this.publishStarted(waiter.id);
  }

  complete(turnId: number, result: TurnResult): void {
    for (const waiter of this.waiters.values()) {
      if (waiter.launchedTurn?.id === turnId) this.settleCompletion(waiter, result);
    }
  }

  materialized(turn: Turn): void {
    const active = this.active;
    if (active === undefined) return;
    for (const [id, turnId] of this.materializedTurnIds) {
      if (turnId !== turn.id) continue;
      active.steeredPromptIds.add(id);
      const waiter = this.waiters.get(id);
      if (waiter !== undefined) this.launched(waiter, turn);
      this.materializedTurnIds.delete(id);
    }
  }

  projectSteered(event: { readonly messages?: readonly UserMessage[]; readonly message?: UserMessage }): boolean {
    const active = this.active;
    if (active === undefined) return false;
    let accepted = false;
    for (const entry of event.messages ?? (event.message === undefined ? [] : [event.message])) {
      const id = entry.attributes?.promptId;
      if (id === undefined) continue;
      this.ensure(entry, true);
      const projection = projectionFromEntry(entry);
      this.steered.set(id, projection);
      accepted = true;
      void this.dispatcher.dispatch(new PromptSteered({
        agentId: this.agentId,
        activePromptId: active.id,
        promptIds: [id],
        messageId: id,
        content: stripBundledSkillBlocks(projection.message),
        steeredAt: new Date().toISOString(),
      }));
    }
    return accepted;
  }

  appended(event: Extract<LoopEmitted, { type: 'message.appended' }>): void {
    if (event.source !== 'normal' && event.source !== 'notify') return;
    const entry = event.message as UserMessage;
    this.entriesByTurn.set(event.turnId, entry);
    this.ensure(entry, false);
    const id = entry.attributes?.promptId;
    if (event.source === 'notify' && id !== undefined) this.materializedTurnIds.set(id, event.turnId);
  }

  entryForTurn(turnId: number): UserMessage | undefined {
    return this.entriesByTurn.get(turnId);
  }

  gateRejected(turnId: number, state: 'blocked' | 'failed'): void {
    const pending = this.pendingTurns.get(turnId);
    this.pendingTurns.delete(turnId);
    const waiter = pending?.waiter;
    if (waiter === undefined || waiter.settled === true) return;
    waiter.settled = true;
    waiter.launched.resolve(undefined);
    waiter.completion.resolve({ promptId: waiter.id, result: undefined, state });
    if (state === 'failed') waiter.failedEntry = pending?.entry;
    this.publishCompleted(waiter.id, state);
    this.terminalStates.set(waiter.id, state);
  }

  cancel(id: string): void {
    const waiter = this.waiters.get(id);
    if (waiter === undefined || waiter.settled === true) return;
    waiter.settled = true;
    waiter.launched.resolve(undefined);
    waiter.completion.resolve({ promptId: id, result: undefined, state: 'cancelled' });
    this.publishAborted(id);
    this.terminalStates.set(id, 'cancelled');
    this.steered.delete(id);
  }

  endActive(prompt: ActivePrompt): void {
    if (this.active === prompt) this.active = undefined;
  }

  close(): void {
    for (const waiter of this.waiters.values()) {
      if (waiter.settled === true) continue;
      waiter.settled = true;
      waiter.launched.resolve(undefined);
      waiter.completion.resolve({ promptId: waiter.id, result: undefined, state: 'cancelled' });
      this.terminalStates.set(waiter.id, 'cancelled');
    }
    this.pendingTurns.clear();
    this.steered.clear();
    this.active = undefined;
  }

  private ensureWaiter(id: string): PromptWaiter {
    return this.waiters.get(id) ?? this.createWaiter(id);
  }

  private createWaiter(id: string): PromptWaiter {
    const waiter: PromptWaiter = {
      id,
      launched: createControlledPromise<Turn | undefined>(),
      completion: createControlledPromise<PromptCompletion>(),
    };
    this.waiters.set(id, waiter);
    return waiter;
  }

  private settleCompletion(waiter: PromptWaiter, result: TurnResult): void {
    if (waiter.settled === true) return;
    waiter.settled = true;
    const state = result.type === 'cancelled' ? 'cancelled' : result.type === 'failed' ? 'failed' : 'completed';
    waiter.completion.resolve({ promptId: waiter.id, result, state });
    if (state === 'cancelled') this.publishAborted(waiter.id);
    else this.publishCompleted(waiter.id, state);
    this.terminalStates.set(waiter.id, state);
    this.steered.delete(waiter.id);
  }

  private projectionOf(id: string): (PromptProjection & { readonly state?: PromptState }) | undefined {
    const failedEntry = this.waiters.get(id)?.failedEntry;
    if (failedEntry !== undefined) return projectionFromEntry(failedEntry);
    if (this.active?.id === id || this.active?.steeredPromptIds.has(id) === true) {
      const active = this.active.id === id ? this.active : this.steered.get(id);
      if (active !== undefined) return { ...active, state: 'running' };
    }
    const steered = this.steered.get(id);
    if (steered !== undefined) return { ...steered, state: 'steered' };
    const entry = this.waiters.get(id)?.entry;
    if (entry !== undefined) return { ...projectionFromEntry(entry), state: this.terminalStates.get(id) };
    return undefined;
  }

  private publishSubmitted(projection: PromptProjection & { readonly id?: string }, status: 'running' | 'queued'): void {
    const promptId = projection.id ?? projection.message.id;
    if (promptId === undefined) return;
    void this.dispatcher.dispatch(new PromptSubmitted({
      agentId: this.agentId,
      promptId,
      userMessageId: projection.userMessageId,
      status,
      content: stripBundledSkillBlocks(projection.message),
      clientMetadata: projection.origin.kind === 'user' ? projection.origin.clientMetadata : undefined,
      createdAt: projection.createdAt,
    }));
  }

  private publishQueued(projection: PromptProjection & { readonly id?: string }, includeCurrent: boolean): void {
    const promptId = projection.id ?? projection.message.id;
    if (promptId === undefined) return;
    void this.dispatcher.dispatch(new PromptQueued({
      agentId: this.agentId,
      promptId,
      content: stripBundledSkillBlocks(projection.message),
      clientMetadata: projection.origin.kind === 'user' ? projection.origin.clientMetadata : undefined,
      queueLength: this.queueLength(includeCurrent),
    }));
  }

  private publishStarted(promptId: string): void {
    void this.dispatcher.dispatch(new PromptStarted({ agentId: this.agentId, promptId }));
  }

  private publishCompleted(promptId: string, reason: 'completed' | 'failed' | 'blocked'): void {
    void this.dispatcher.dispatch(new PromptCompleted({
      agentId: this.agentId,
      promptId,
      finishedAt: new Date().toISOString(),
      reason,
    }));
  }

  private publishAborted(promptId: string): void {
    void this.dispatcher.dispatch(new PromptAborted({
      agentId: this.agentId,
      promptId,
      abortedAt: new Date().toISOString(),
    }));
  }
}

function projectionFromEntry(entry: UserMessage): ActivePrompt {
  const origin = (entry.attributes?.origin as PromptOrigin | undefined) ?? { kind: 'user' };
  return {
    id: entry.attributes?.promptId ?? newMessageId(),
    promptId: entry.attributes?.promptId,
    origin,
    message: {
      role: 'user',
      content: [...entry.content],
      id: entry.attributes?.promptId,
      origin: entry.attributes?.origin as PromptOrigin | undefined,
    },
    userMessageId: entry.attributes?.userMessageId ?? entry.attributes?.promptId ?? '',
    createdAt: entry.attributes?.createdAt ?? new Date().toISOString(),
  };
}

export function promptHistoryEntry(event: { readonly message: Message }): UserMessage | undefined {
  return event.message.role === 'user' ? event.message : undefined;
}
