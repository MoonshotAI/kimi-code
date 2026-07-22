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
 *    time; the first returned `veto` decides the call, while a returned
 *    `executionMetadata` joins the pass trace.
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
import type {
  ExecutableTool,
  ExecutableToolResult,
  RunnableToolExecution,
} from '#/tool/toolContract';

import type {
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
} from './toolHooks';

type PendingVetoFactory = () => Promise<BeforeExecuteDecision | undefined>;

/** Convenience for the common veto shape: a denial carrying only a message. */
export function denyToolExecution(reason: string): ExecutableToolResult {
  return { output: reason, isError: true };
}

export class BeforeToolExecuteEventImpl implements BeforeToolExecuteEvent {
  readonly turnId: number;
  readonly signal: AbortSignal;
  readonly trace?: LLMRequestTrace;
  readonly toolCall: ToolCall;
  readonly toolCalls: readonly ToolCall[];
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;
  readonly execution: RunnableToolExecution;

  private _vetoResult: ExecutableToolResult | undefined;
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

  veto(result: ExecutableToolResult): void {
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

  get vetoResult(): ExecutableToolResult | undefined {
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
  ): Promise<BeforeExecuteDecision | undefined> {
    if (this.isDisposed || this._listeners === undefined || this._listeners.size === 0) {
      return undefined;
    }

    const event = new BeforeToolExecuteEventImpl(context);
    for (const entry of Array.from(this._listeners)) {
      await entry.listener.call(entry.thisArg, event);
      if (event.finalAllowed) return undefined;
      if (event.vetoResult !== undefined) return { veto: event.vetoResult };
    }
    event.closeRegistration();

    let passMetadata = event.passMetadata;
    for (const factory of event.pendingVetos) {
      const decision = await factory();
      if (decision?.veto !== undefined) return { veto: decision.veto };
      passMetadata ??= decision?.executionMetadata;
    }
    return passMetadata === undefined ? undefined : { executionMetadata: passMetadata };
  }
}
