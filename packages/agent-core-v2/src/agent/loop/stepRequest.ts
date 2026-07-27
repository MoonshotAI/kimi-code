/**
 * `loop` domain (L4) — `StepRequest` contracts for the loop's step queue.
 *
 * A `StepRequest` is one queued unit of step work. Senders (`prompt`, `goal`,
 * `externalHooks`) create plain request objects and hand them to
 * `IAgentLoopService.enqueue`; requests carry no DI identity of their own, so
 * constructing them with `new` is expected. Each request describes the context
 * message(s) it contributes — computed lazily at pop time through
 * `resolveContextMessages` — plus its queue semantics (`mergeable`,
 * `turnScoped`). Because the message only materializes when the loop pops the
 * request, an aborted request is discarded without ever touching the context:
 * removal needs no compensating undo. Runtime types only; not registered with
 * the container.
 */

import { randomUUID } from 'node:crypto';

import type { ContentPart } from '#/kosong/contract/message';
import { USER_PROMPT_ORIGIN, type ContextMessage, type PromptOrigin } from '#/agent/contextMemory/types';

export type StepRequestState = 'pending' | 'materialized' | 'aborted';

export type StepRequestAdmission =
  | 'newTurn'
  | 'activeOrNewTurn'
  | 'activeOrNextTurn'
  | 'activeTurnOnly';

export interface TurnSeed {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface StepRequestOptions {
  readonly mergeable?: boolean;
  readonly turnScoped?: boolean;
  readonly admission?: StepRequestAdmission;
}

export abstract class StepRequest {
  readonly id: string = randomUUID();
  abstract readonly kind: string;
  readonly mergeable: boolean;
  readonly turnScoped: boolean;
  readonly admission: StepRequestAdmission;

  private _state: StepRequestState = 'pending';

  constructor(options: StepRequestOptions = {}) {
    this.mergeable = options.mergeable ?? false;
    this.turnScoped = options.turnScoped ?? true;
    this.admission = options.admission ?? 'activeOrNextTurn';
  }

  get turnSeed(): TurnSeed | undefined {
    return undefined;
  }

  get state(): StepRequestState {
    return this._state;
  }

  get aborted(): boolean {
    return this._state === 'aborted';
  }

  abort(): boolean {
    if (this._state !== 'pending') return false;
    this._state = 'aborted';
    this.onSettled();
    return true;
  }

  onWillMaterialize(): void {}

  abstract resolveContextMessages(): readonly ContextMessage[];

  markMaterialized(): void {
    if (this._state !== 'pending') return;
    this._state = 'materialized';
    this.onSettled();
  }

  protected onSettled(): void {}
}

export interface MessageStepRequestOptions extends StepRequestOptions {
  readonly kind?: string;
}

export class MessageStepRequest extends StepRequest {
  readonly kind: string;

  constructor(
    private readonly message: ContextMessage,
    options: MessageStepRequestOptions = {},
  ) {
    super(options);
    this.kind = options.kind ?? 'message';
  }

  override get turnSeed(): TurnSeed {
    return { input: this.message.content, origin: this.message.origin ?? USER_PROMPT_ORIGIN };
  }

  resolveContextMessages(): readonly ContextMessage[] {
    return [this.message];
  }
}

export class ContinuationStepRequest extends StepRequest {
  readonly kind: string;

  constructor(options: MessageStepRequestOptions = {}) {
    super(options);
    this.kind = options.kind ?? 'continuation';
  }

  resolveContextMessages(): readonly ContextMessage[] {
    return [];
  }
}
