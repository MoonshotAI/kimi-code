import {
  RequestError,
  type AgentSideConnection,
  type ContentBlock,
  type PromptRequest,
  type PromptResponse,
  type SessionModelState,
  type SessionUpdate,
  type StopReason,
  type ToolCallContent,
} from '@agentclientprotocol/sdk';
import {
  log,
  type ApprovalRequest,
  type Event,
  type KimiConfig,
  type Session,
  type TurnEndReason,
} from '@moonshot-ai/kimi-code-sdk';

import { acpPromptToKimiInput } from './content-adapter';
import { toAcpRequestError } from './errors';
import { createAcpModelState } from './model-adapter';
import {
  approvalRequestToToolCallUpdate,
  approvalResponseFromOutcome,
  defaultPermissionOptions,
  displayToContent,
  displayToLocations,
  displayToToolKind,
  stringifyForDisplay,
  textToolContent,
  toAcpToolCallId,
  toolUpdateToText,
} from './tool-adapter';

interface TurnEndState {
  readonly reason: TurnEndReason;
  readonly error?: unknown;
}

interface PendingPermission {
  readonly cancel: () => void;
}

interface PendingTurn {
  readonly resolve: (state: TurnEndState) => void;
}

export class KimiAcpSession {
  private readonly unsubscribe: () => void;
  private eventQueue: Promise<void> = Promise.resolve();
  private activeTurnId: number | undefined;
  private lastTurnEnd: TurnEndState | undefined;
  private runningPrompt = false;
  private closed = false;
  private readonly toolContents = new Map<string, ToolCallContent[]>();
  private readonly toolInputFragments = new Map<string, string>();
  private readonly pendingPermissions = new Set<PendingPermission>();
  private pendingTurn: PendingTurn | undefined;

  constructor(
    private readonly session: Session,
    private readonly connection: AgentSideConnection,
  ) {
    this.unsubscribe = session.onEvent((event) => {
      this.handleEvent(event);
    });
    session.setApprovalHandler((request) => this.requestPermission(request));
  }

  get id(): string {
    return this.session.id;
  }

  async modelState(config: KimiConfig): Promise<SessionModelState | undefined> {
    this.ensureOpen();
    return createAcpModelState(config, this.session);
  }

  async setModel(modelId: string): Promise<void> {
    this.ensureOpen();
    await this.session.setModel(modelId);
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    this.ensureOpen();
    if (this.runningPrompt) {
      throw RequestError.invalidParams(
        { sessionId: this.id },
        `Session "${this.id}" is already processing a prompt.`,
      );
    }

    const input = acpPromptToKimiInput(request.prompt);
    this.runningPrompt = true;
    this.activeTurnId = undefined;
    this.lastTurnEnd = undefined;
    this.toolContents.clear();
    this.toolInputFragments.clear();

    try {
      const turnEnded = this.waitForPromptTurnEnd();
      this.sendUserPromptChunks(request.prompt, request.messageId);
      await this.session.prompt(input);
      const turnEnd = await turnEnded;
      this.lastTurnEnd = turnEnd;
      await this.flushEvents();
      return promptResponseFromTurnEnd(this.lastTurnEnd, request.messageId);
    } catch (error) {
      throw toAcpRequestError(error);
    } finally {
      this.runningPrompt = false;
    }
  }

  async cancel(): Promise<void> {
    this.ensureOpen();
    this.cancelPendingPermissions();
    await this.session.cancel();
    this.resolvePromptTurn({ reason: 'cancelled' });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.session.setApprovalHandler(undefined);
    this.unsubscribe();
    this.cancelPendingPermissions();
    if (this.runningPrompt) {
      await this.session.cancel().catch((error: unknown) => {
        log.warn('acp session cancel during close failed', { sessionId: this.id, error });
      });
      this.resolvePromptTurn({ reason: 'cancelled' });
    }
    await this.session.close();
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw toAcpRequestError(new Error(`Session "${this.id}" is closed.`));
    }
  }

  private async requestPermission(request: ApprovalRequest) {
    const options = defaultPermissionOptions();
    const pending = this.trackPendingPermission();
    try {
      const response = await Promise.race([
        this.connection.requestPermission({
          sessionId: this.id,
          toolCall: approvalRequestToToolCallUpdate(request),
          options: [...options],
        }),
        pending.cancelled,
      ]);
      const approval = approvalResponseFromOutcome(response.outcome, options);
      if (approval.decision !== 'approved') {
        this.sendPermissionDeniedUpdate(request, approval.decision);
      }
      return approval;
    } catch (error) {
      log.warn('acp permission request failed', { sessionId: this.id, error });
      this.sendPermissionDeniedUpdate(request, 'cancelled');
      return {
        decision: 'cancelled' as const,
        feedback: 'ACP client did not return a permission decision.',
      };
    } finally {
      this.pendingPermissions.delete(pending.record);
    }
  }

  private trackPendingPermission(): {
    readonly record: PendingPermission;
    readonly cancelled: Promise<{ outcome: { outcome: 'cancelled' } }>;
  } {
    let cancel!: () => void;
    const cancelled = new Promise<{ outcome: { outcome: 'cancelled' } }>((resolve) => {
      cancel = () => {
        resolve({ outcome: { outcome: 'cancelled' } });
      };
    });
    const record: PendingPermission = { cancel };
    this.pendingPermissions.add(record);
    return { record, cancelled };
  }

  private cancelPendingPermissions(): void {
    for (const pending of Array.from(this.pendingPermissions)) {
      pending.cancel();
      this.pendingPermissions.delete(pending);
    }
  }

  private sendPermissionDeniedUpdate(
    request: ApprovalRequest,
    decision: 'rejected' | 'cancelled',
  ): void {
    const toolCallId = toAcpToolCallId(request.turnId, request.toolCallId);
    const content = this.appendToolContent(
      toolCallId,
      decision === 'rejected' ? 'Permission rejected.' : 'Permission cancelled.',
    );
    this.send({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      title: request.action,
      status: 'failed',
      content,
    });
  }

  private handleEvent(event: Event): void {
    switch (event.type) {
      case 'turn.started':
        this.activeTurnId = event.turnId;
        return;
      case 'turn.ended':
        this.resolvePromptTurn({ reason: event.reason, error: event.error });
        return;
      case 'assistant.delta':
        if (this.isActiveTurn(event.turnId)) {
          this.sendTextChunk('agent_message_chunk', event.delta);
        }
        return;
      case 'thinking.delta':
        if (this.isActiveTurn(event.turnId)) {
          this.sendTextChunk('agent_thought_chunk', event.delta);
        }
        return;
      case 'hook.result':
        if (this.isActiveTurn(event.turnId)) {
          this.sendTextChunk('agent_thought_chunk', event.content);
        }
        return;
      case 'tool.call.started':
        this.handleToolCallStarted(event);
        return;
      case 'tool.call.delta':
        this.handleToolCallDelta(event);
        return;
      case 'tool.progress':
        this.handleToolProgress(event);
        return;
      case 'tool.result':
        this.handleToolResult(event);
        return;
      case 'mcp.server.status':
        this.sendTextChunk(
          'agent_thought_chunk',
          `MCP ${event.server.name}: ${event.server.status}${event.server.error ? `\n${event.server.error}` : ''}`,
        );
        return;
      case 'warning':
        this.sendTextChunk('agent_thought_chunk', `Warning: ${event.message}`);
        return;
      case 'error':
        this.sendTextChunk('agent_message_chunk', event.message);
        return;
      case 'agent.status.updated':
      case 'session.meta.updated':
      case 'skill.activated':
      case 'turn.step.started':
      case 'turn.step.completed':
      case 'turn.step.retrying':
      case 'turn.step.interrupted':
      case 'tool.list.updated':
      case 'subagent.spawned':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'compaction.started':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed':
      case 'background.task.started':
      case 'background.task.updated':
      case 'background.task.terminated':
        return;
      default: {
        const exhaustive: never = event;
        void exhaustive;
        return;
      }
    }
  }

  private handleToolCallStarted(event: Extract<Event, { type: 'tool.call.started' }>): void {
    if (!this.isActiveTurn(event.turnId)) return;
    const toolCallId = toAcpToolCallId(event.turnId, event.toolCallId);
    const content = displayToContent(event.display);
    if (content !== undefined) {
      this.toolContents.set(toolCallId, content);
    }

    this.send({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: event.description ?? event.name,
      kind: displayToToolKind(event.display, event.name),
      status: 'in_progress',
      rawInput: event.args,
      locations: displayToLocations(event.display),
      content,
    });
  }

  private handleToolCallDelta(event: Extract<Event, { type: 'tool.call.delta' }>): void {
    if (!this.isActiveTurn(event.turnId)) return;
    const toolCallId = toAcpToolCallId(event.turnId, event.toolCallId);
    const previous = this.toolInputFragments.get(toolCallId) ?? '';
    const rawInput =
      event.argumentsPart === undefined ? previous : `${previous}${event.argumentsPart}`;
    if (rawInput.length > 0) {
      this.toolInputFragments.set(toolCallId, rawInput);
    }

    this.send({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'in_progress',
      title: event.name,
      rawInput: rawInput.length === 0 ? undefined : rawInput,
    });
  }

  private handleToolProgress(event: Extract<Event, { type: 'tool.progress' }>): void {
    if (!this.isActiveTurn(event.turnId)) return;
    const toolCallId = toAcpToolCallId(event.turnId, event.toolCallId);
    const text = toolUpdateToText(event.update);
    const content = this.appendToolContent(toolCallId, text);
    this.send({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'in_progress',
      content: content.length === 0 ? undefined : content,
    });
  }

  private handleToolResult(event: Extract<Event, { type: 'tool.result' }>): void {
    if (!this.isActiveTurn(event.turnId)) return;
    const toolCallId = toAcpToolCallId(event.turnId, event.toolCallId);
    const output = stringifyForDisplay(event.output);
    const content = output.length === 0
      ? this.toolContents.get(toolCallId) ?? []
      : this.appendToolContent(toolCallId, output);
    this.send({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: event.isError === true ? 'failed' : 'completed',
      rawOutput: event.output,
      content: content.length === 0 ? undefined : content,
    });
  }

  private appendToolContent(toolCallId: string, text: string): ToolCallContent[] {
    if (text.length === 0) return this.toolContents.get(toolCallId) ?? [];
    const content = [...(this.toolContents.get(toolCallId) ?? []), textToolContent(text)];
    this.toolContents.set(toolCallId, content);
    return content;
  }

  private isActiveTurn(turnId: number): boolean {
    return this.activeTurnId === undefined || this.activeTurnId === turnId;
  }

  private sendUserPromptChunks(
    prompt: readonly ContentBlock[],
    messageId: string | null | undefined,
  ): void {
    for (const block of prompt) {
      this.send({
        sessionUpdate: 'user_message_chunk',
        content: block,
        messageId: messageId ?? undefined,
      });
    }
  }

  private sendTextChunk(
    sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
    text: string,
  ): void {
    if (text.length === 0) return;
    this.send({
      sessionUpdate,
      content: {
        type: 'text',
        text,
      },
    });
  }

  private send(update: SessionUpdate): void {
    this.eventQueue = this.eventQueue
      .catch(() => {})
      .then(() => this.connection.sessionUpdate({ sessionId: this.id, update }))
      .catch((error: unknown) => {
        log.warn('acp session update failed', { sessionId: this.id, error });
      });
  }

  private async flushEvents(): Promise<void> {
    await this.eventQueue.catch(() => {});
  }

  private waitForPromptTurnEnd(): Promise<TurnEndState> {
    return new Promise((resolve) => {
      this.pendingTurn = { resolve };
    });
  }

  private resolvePromptTurn(state: TurnEndState): void {
    this.lastTurnEnd = state;
    const pending = this.pendingTurn;
    if (pending === undefined) return;
    this.pendingTurn = undefined;
    pending.resolve(state);
  }
}

function promptResponseFromTurnEnd(
  turnEnd: TurnEndState | undefined,
  messageId: string | null | undefined,
): PromptResponse {
  if (turnEnd?.reason === 'failed') {
    throw toAcpRequestError(turnEnd.error ?? new Error('Prompt turn failed.'));
  }

  const stopReason: StopReason = turnEnd?.reason === 'cancelled' ? 'cancelled' : 'end_turn';
  return {
    stopReason,
    userMessageId: messageId ?? undefined,
  };
}
