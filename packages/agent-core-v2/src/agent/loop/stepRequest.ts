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

import type { ContentPart } from '#/app/llmProtocol/message';
import { USER_PROMPT_ORIGIN, type ContextMessage, type PromptOrigin } from '#/agent/contextMemory/types';

export type StepRequestState = 'pending' | 'materialized' | 'aborted';

export type StepRequestAdmission =
  | 'newTurn'
  | 'activeOrNewTurn'
  | 'activeOrNextTurn'
  | 'activeTurnOnly';

/** Input/origin recorded through `turn.prompt` when a request starts a turn. */
export interface TurnSeed {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface StepRequestOptions {
  /** Mergeable requests fold into the next step's driver instead of forcing their own. */
  readonly mergeable?: boolean;
  /** Turn-scoped requests are aborted when the owning run ends; agent-scoped ones (steers) carry into the next turn. */
  readonly turnScoped?: boolean;
  /** Turn admission semantics. Defaults to `activeOrNextTurn`. */
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

  /** Seed for the `turn.prompt` record when this request starts a turn. */
  get turnSeed(): TurnSeed | undefined {
    return undefined;
  }

  get state(): StepRequestState {
    return this._state;
  }

  get aborted(): boolean {
    return this._state === 'aborted';
  }

  /**
   * Abort a still-pending request; the loop discards it when popped. Returns
   * false once the request has materialized — its message already landed in
   * context and can no longer be withdrawn.
   */
  abort(): boolean {
    if (this._state !== 'pending') return false;
    this._state = 'aborted';
    this.onSettled();
    return true;
  }

  /**
   * One-time side effects run by the loop right before the request's messages
   * are appended (wire record-keeping, reminder rerouting). Called at most
   * once, at pop time.
   */
  onWillMaterialize(): void {}

  /**
   * Compute this request's context contribution at pop time. Called at most
   * once; the loop appends the returned messages to the context. Requests
   * that only drive a step (continuations, retries) return an empty list.
   */
  abstract resolveContextMessages(): readonly ContextMessage[];

  /** Loop-only transition invoked at pop time; idempotent. */
  markMaterialized(): void {
    if (this._state !== 'pending') return;
    this._state = 'materialized';
    this.onSettled();
  }

  /** Fired exactly once when the request leaves the pending state (materialized or aborted). */
  protected onSettled(): void {}
}

export interface MessageStepRequestOptions extends StepRequestOptions {
  readonly kind?: string;
}

/**
 * A request carrying a single pre-built context message. Domains with
 * materialization side effects (caption rerouting, steer record-keeping)
 * subclass it and override `onWillMaterialize`.
 */
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

/**
 * A message-less driver request: contributes no context of its own and simply
 * runs one more step over the current context. Enqueued by the loop after a
 * tool-executing step, and by orchestrators (`goal`, `externalHooks`) that
 * need one extra step after delivering their own input.
 */
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
