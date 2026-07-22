/**
 * `toolExecutor` domain (L3) — `onBeforeExecuteTool` veto-event machinery.
 *
 * `BeforeToolExecuteEventImpl` is the per-fire event object listeners
 * adjudicate through; `BeforeToolExecuteEmitter` owns the listener registry
 * and the two-pass fire:
 *
 * 1. immediate statements — each listener is awaited in registration order;
 *    `veto(result)` wins on the spot (first come, first served) and
 *    `allow()` ends adjudication outright, both before any later listener
 *    runs;
 * 2. deferred adjudications — only when pass 1 produced no decision, the
 *    cold factories registered via `waitUntil(factory)` are invoked one at a
 *    time, and the first returned payload decides the call.
 *
 * Because the factories stay cold through pass 1, an approval round-trip
 * (the only side-effecting adjudication) can never start while another
 * listener would have denied the call. All four statements throw once the
 * statement window closes (mirroring `AsyncEmitter`'s "waitUntil can NOT be
 * called asynchronously" rule): a late veto would otherwise be silently
 * ignored.
 */

import { Emitter } from '#/_base/event';
import type { ToolCall } from '#/kosong/contract/message';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import type { ExecutableTool, RunnableToolExecution } from '#/tool/toolContract';

import type {
  AuthorizeToolExecutionResult,
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
} from './toolHooks';

type PendingVetoFactory = () => Promise<AuthorizeToolExecutionResult | undefined>;

export class BeforeToolExecuteEventImpl implements BeforeToolExecuteEvent {
  readonly turnId: number;
  readonly signal: AbortSignal;
  readonly trace?: LLMRequestTrace;
  readonly toolCall: ToolCall;
  readonly toolCalls: readonly ToolCall[];
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;
  readonly execution: RunnableToolExecution;

  private _vetoResult: AuthorizeToolExecutionResult | undefined;
  private _finalAllowed = false;
  private _passMetadata: unknown;
  private readonly _pendingVetos: PendingVetoFactory[] = [];
  private _open = true;

  constructor(context: ResolvedToolExecutionHookContext) {
    this.turnId = context.turnId;
    this.signal = context.signal;
    this.trace = context.trace;
    this.toolCall = context.toolCall;
    this.toolCalls = context.toolCalls;
    this.tool = context.tool;
    this.args = context.args;
    this.execution = context.execution;
  }

  veto(result: AuthorizeToolExecutionResult): void {
    this.assertOpen('veto');
    this._vetoResult ??= result;
  }

  allow(): void {
    this.assertOpen('allow');
    this._finalAllowed = true;
  }

  pass(metadata?: unknown): void {
    this.assertOpen('pass');
    this._passMetadata ??= metadata;
  }

  waitUntil(factory: PendingVetoFactory): void {
    this.assertOpen('waitUntil');
    this._pendingVetos.push(factory);
  }

  get vetoResult(): AuthorizeToolExecutionResult | undefined {
    return this._vetoResult;
  }

  get finalAllowed(): boolean {
    return this._finalAllowed;
  }

  get passMetadata(): unknown {
    return this._passMetadata;
  }

  get pendingVetos(): readonly PendingVetoFactory[] {
    return this._pendingVetos;
  }

  closeRegistration(): void {
    this._open = false;
  }

  private assertOpen(statement: string): void {
    if (!this._open) {
      throw new Error(`${statement} can NOT be called asynchronously`);
    }
  }
}

export class BeforeToolExecuteEmitter extends Emitter<BeforeToolExecuteEvent> {
  async fireBeforeExecute(
    context: ResolvedToolExecutionHookContext,
  ): Promise<AuthorizeToolExecutionResult | undefined> {
    if (this.isDisposed || this._listeners === undefined || this._listeners.size === 0) {
      return undefined;
    }

    const event = new BeforeToolExecuteEventImpl(context);
    for (const entry of Array.from(this._listeners)) {
      await entry.listener.call(entry.thisArg, event);
      if (event.finalAllowed) return undefined;
      if (event.vetoResult !== undefined) return event.vetoResult;
    }
    event.closeRegistration();

    for (const factory of event.pendingVetos) {
      const result = await factory();
      if (result !== undefined) return result;
    }
    return event.passMetadata === undefined
      ? undefined
      : { executionMetadata: event.passMetadata };
  }
}
