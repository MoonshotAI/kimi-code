import { Emitter } from '#/_base/event';
import { BugIndicatingError } from '#/errors';
import type { ToolCall } from '#human/llm/message';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
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

interface PendingVetoEntry {
  readonly listener?: unknown;
  readonly factory: PendingVetoFactory;
}

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
  private _updatedArgs: Record<string, unknown> | undefined;
  private _currentListener: unknown;
  private readonly _pendingVetos: PendingVetoEntry[] = [];
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

  updateArgs(args: Record<string, unknown>): void {
    this.assertOpen('updateArgs');
    this._updatedArgs = args;
  }

  setCurrentListener(listener: unknown): void {
    this._currentListener = listener;
  }

  waitUntil(factory: PendingVetoFactory): void {
    this.assertOpen('waitUntil');
    this._pendingVetos.push({ listener: this._currentListener, factory });
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

  get updatedArgs(): Record<string, unknown> | undefined {
    return this._updatedArgs;
  }

  get pendingVetos(): readonly PendingVetoEntry[] {
    return this._pendingVetos;
  }

  closeRegistration(): void {
    this._open = false;
  }

  private assertOpen(statement: string): void {
    if (!this._open) {
      throw new BugIndicatingError(`${statement} can NOT be called asynchronously`);
    }
  }
}

export class BeforeToolExecuteEmitter extends Emitter<BeforeToolExecuteEvent> {
  async fireBeforeExecute(
    context: ResolvedToolExecutionHookContext,
    skipListeners?: ReadonlySet<unknown>,
  ): Promise<BeforeExecuteDecision | undefined> {
    if (this.isDisposed || this._listeners === undefined || this._listeners.size === 0) {
      return undefined;
    }

    const event = new BeforeToolExecuteEventImpl(context);
    for (const entry of Array.from(this._listeners)) {
      if (skipListeners?.has(entry)) continue;
      event.setCurrentListener(entry);
      await entry.listener.call(entry.thisArg, event);
      if (event.vetoResult !== undefined) return { veto: event.vetoResult };
      if (event.updatedArgs !== undefined) {
        return { updatedArgs: event.updatedArgs, updatedBy: entry };
      }
      if (event.finalAllowed) return undefined;
    }
    event.closeRegistration();

    let passMetadata = event.passMetadata;
    for (const pending of event.pendingVetos) {
      const decision = await pending.factory();
      if (decision?.veto !== undefined) return { veto: decision.veto };
      if (decision?.updatedArgs !== undefined) {
        return {
          updatedArgs: decision.updatedArgs,
          updatedBy: decision.updatedBy ?? pending.listener,
        };
      }
      passMetadata ??= decision?.executionMetadata;
    }
    return passMetadata === undefined ? undefined : { executionMetadata: passMetadata };
  }
}
