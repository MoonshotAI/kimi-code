import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { BugIndicatingError } from '#/errors';
import type { ToolCall } from '#/kosong/contract/message';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import type {
  ExecutableTool,
  ExecutableToolResult,
  RunnableToolExecution,
} from '#/tool/toolContract';

import type {
  ToolExecutionParticipationOrder,
  ToolExecutionVetoListener,
} from '#/actor/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
} from '#/actor/toolExecutor/toolHooks';
import {
  insertIndexByRank,
  participantRank,
  VETO_PARTICIPANT_ORDER,
} from '#/actor/toolExecutor/internal/participants';

type PendingVetoFactory = () => Promise<BeforeExecuteDecision | undefined>;

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
      throw new BugIndicatingError(`${statement} can NOT be called asynchronously`);
    }
  }
}

interface VetoParticipant {
  readonly name: string;
  readonly listener: ToolExecutionVetoListener;
  readonly rank: number;
}

export class BeforeToolExecuteBus {
  private readonly participants: VetoParticipant[] = [];

  register(
    name: string,
    listener: ToolExecutionVetoListener,
    order: ToolExecutionParticipationOrder = 'prePolicy',
  ): IDisposable {
    this.remove(name);
    const entry: VetoParticipant = {
      name,
      listener,
      rank: participantRank(VETO_PARTICIPANT_ORDER, name, order),
    };
    this.participants.splice(
      insertIndexByRank(
        this.participants.map((participant) => participant.rank),
        entry.rank,
      ),
      0,
      entry,
    );
    return toDisposable(() => {
      const index = this.participants.indexOf(entry);
      if (index < 0) return;
      this.participants.splice(index, 1);
    });
  }

  participantNames(): readonly string[] {
    return this.participants.map((participant) => participant.name);
  }

  private remove(name: string): void {
    const index = this.participants.findIndex((participant) => participant.name === name);
    if (index >= 0) this.participants.splice(index, 1);
  }

  async fireBeforeExecute(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    if (this.participants.length === 0) {
      return undefined;
    }

    const event = new BeforeToolExecuteEventImpl(context);
    for (const participant of Array.from(this.participants)) {
      await participant.listener(event);
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
