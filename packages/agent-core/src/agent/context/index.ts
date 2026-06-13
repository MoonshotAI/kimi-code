import { createToolMessage, type ContentPart, type Message } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { ErrorCodes, KimiError } from '../../errors';
import type { ExecutableToolResult, LoopRecordedEvent } from '../../loop';
import { estimateTokensForMessages } from '../../utils/tokens';
import type { CompactionResult } from '../compaction';
import { project, trimTrailingOpenToolExchange } from './projector';
import {
  USER_PROMPT_ORIGIN,
  type AgentContextData,
  type ContextMessage,
  type PromptOrigin,
} from './types';

export * from './types';

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

export class ContextMemory {
  private _history: ContextMessage[] = [];
  private _tokenCount = 0;
  private tokenCountCoveredMessageCount = 0;
  private openSteps: Map<string, ContextMessage> = new Map();
  private pendingToolResultIds = new Set<string>();
  private deferredMessages: ContextMessage[] = [];
  private _lastAssistantAt: number | null = null;

  constructor(protected readonly agent: Agent) {}

  get lastAssistantAt(): number | null {
    return this._lastAssistantAt;
  }

  appendUserMessage(
    content: readonly ContentPart[],
    origin: PromptOrigin = USER_PROMPT_ORIGIN,
  ): void {
    if (content.length === 0) return;
    this.appendMessage({
      role: 'user',
      content: [...content],
      toolCalls: [],
      origin,
    });
  }

  appendSystemReminder(content: string, origin: PromptOrigin): void {
    const text = `<system-reminder>\n${content.trim()}\n</system-reminder>`;
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin,
    });
  }

  popMatchedMessage(matcher: (origin: PromptOrigin | undefined) => boolean): boolean {
    const lastDeferred = this.deferredMessages.at(-1);
    const last = lastDeferred ?? this._history.at(-1);
    if (last === undefined) return false;
    if (!matcher(last.origin)) return false;
    if (lastDeferred !== undefined) {
      this.deferredMessages.pop();
    } else {
      this._history.pop();
    }
    return true;
  }

  clear(): void {
    this.agent.records.logRecord({ type: 'context.clear' });
    this._history = [];
    this._tokenCount = 0;
    this.tokenCountCoveredMessageCount = 0;
    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    this.deferredMessages = [];
    this._lastAssistantAt = null;
    this.agent.microCompaction.reset();
    this.agent.injection.onContextClear();
    this.agent.emitStatusUpdated();
  }

  undo(count: number): void {
    if (count <= 0) return;
    if (this._history.length === 0) return;

    this.agent.records.logRecord({ type: 'context.undo', count });

    let removedUserCount = 0;
    const removedMessages = new Set<ContextMessage>();
    let stoppedAtBoundary = false;
    for (let i = this._history.length - 1; i >= 0; i--) {
      const message = this._history[i];
      if (message === undefined) continue;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') {
        stoppedAtBoundary = true;
        break;
      }

      removedMessages.add(message);
      this._history.splice(i, 1);
      this.agent.injection.onContextMessageRemoved(i);

      if (i < this.tokenCountCoveredMessageCount) {
        this.tokenCountCoveredMessageCount--;
        this._tokenCount -= estimateTokensForMessages([message]);
      }

      if (isRealUserPrompt(message)) {
        removedUserCount++;
        if (removedUserCount >= count) break;
      }
    }

    this.agent.replayBuilder.removeLastMessages(removedMessages);

    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    this.deferredMessages = [];
    this.agent.microCompaction.reset(this._history.length);
    this.agent.emitStatusUpdated();

    if (
      !this.agent.records.restoring &&
      (stoppedAtBoundary || removedUserCount < count)
    ) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        formatUndoUnavailableMessage(count, removedUserCount, stoppedAtBoundary),
        {
          details: {
            reason: 'undo_limit',
            requestedCount: count,
            undoableCount: removedUserCount,
            stoppedAtCompaction: stoppedAtBoundary,
          },
        },
      );
    }
  }

  applyCompaction(summary: CompactionResult): void {
    this.agent.records.logRecord({
      type: 'context.apply_compaction',
      ...summary,
    });
    this._history = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: summary.summary }],
        toolCalls: [],
        origin: { kind: 'compaction_summary' },
      },
      ...this._history.slice(summary.compactedCount),
    ];
    this.openSteps.clear();
    this.flushDeferredMessagesIfToolExchangeClosed();
    this._tokenCount = summary.tokensAfter;
    this.tokenCountCoveredMessageCount = this._history.length;
    this.agent.microCompaction.reset();
    this.agent.injection.onContextCompacted(summary.compactedCount);
    this.agent.emitStatusUpdated();
  }

  data(): AgentContextData {
    return {
      history: this.history,
      tokenCount: this.tokenCount,
    };
  }

  get tokenCount(): number {
    return this._tokenCount;
  }

  get tokenCountWithPending(): number {
    const pendingMessages = this._history.slice(this.tokenCountCoveredMessageCount);
    return this._tokenCount + estimateTokensForMessages(pendingMessages);
  }

  get history(): readonly ContextMessage[] {
    return this._history;
  }

  project(messages: readonly ContextMessage[]): Message[] {
    return project(this.agent.microCompaction.compact(messages));
  }

  get messages(): Message[] {
    return this.project(this.history);
  }

  useProjectedHistoryFrom(source: ContextMemory): void {
    this.clear();
    this.pushHistory(...trimTrailingOpenToolExchange(source.project(source.history)));
  }

  appendLoopEvent(event: LoopRecordedEvent): void {
    this.agent.records.logRecord({
      type: 'context.append_loop_event',
      event,
    });
    switch (event.type) {
      case 'step.begin': {
        const message: ContextMessage = {
          role: 'assistant',
          content: [],
          toolCalls: [],
        };
        this.pushHistory(message);
        this.openSteps.set(event.uuid, message);
        return;
      }
      case 'step.end': {
        const openStep = this.openSteps.get(event.uuid);
        this.openSteps.delete(event.uuid);
        if (event.usage !== undefined) {
          const openStepIndex = openStep === undefined ? -1 : this._history.indexOf(openStep);
          this._tokenCount =
            event.usage.inputCacheRead +
            event.usage.inputCacheCreation +
            event.usage.inputOther +
            event.usage.output;
          this.tokenCountCoveredMessageCount =
            openStepIndex === -1 ? this._history.length : openStepIndex + 1;
        }
        this.flushDeferredMessagesIfToolExchangeClosed();
        return;
      }
      case 'content.part': {
        const openStep = this.openSteps.get(event.stepUuid);
        if (openStep === undefined) {
          throw new Error(
            `Received content_part for unknown step_uuid '${event.stepUuid}' (no open step_begin)`,
          );
        }
        openStep.content.push(event.part);
        return;
      }
      case 'tool.call': {
        // Skip stale tool_call_ids from previous incomplete turns.
        // These are identified during replay pre-scan and would otherwise
        // pollute pendingToolResultIds, causing deferred user messages.
        if (this.agent.staleToolCallIds.has(event.toolCallId)) {
          return;
        }
        const openStep = this.openSteps.get(event.stepUuid);
        if (openStep === undefined) {
          throw new Error(
            `Received tool_call for unknown step_uuid '${event.stepUuid}' (no open step_begin)`,
          );
        }
        openStep.toolCalls.push({
          type: 'function',
          id: event.toolCallId,
          name: event.name,
          arguments: event.args === undefined ? null : JSON.stringify(event.args),
        });
        this.pendingToolResultIds.add(event.toolCallId);
        return;
      }
      case 'tool.result': {
        const message = createToolMessage(event.toolCallId, toolResultOutputForModel(event.result));
        this.pushHistory({
          ...message,
          role: 'tool',
          isError: event.result.isError,
        });
        this.pendingToolResultIds.delete(event.toolCallId);
        this.flushDeferredMessagesIfToolExchangeClosed();
        return;
      }
    }
  }

  appendMessage(message: ContextMessage): void {
    this.agent.records.logRecord({
      type: 'context.append_message',
      message,
    });
    if (this.hasOpenToolExchange()) {
      this.deferredMessages.push(message);
      return;
    }
    this.pushHistory(message);
  }

  private flushDeferredMessagesIfToolExchangeClosed(): void {
    if (this.pendingToolResultIds.size > 0 || this.deferredMessages.length === 0) {
      return;
    }
    this.pushHistory(...this.deferredMessages);
    this.deferredMessages = [];
  }

  private hasOpenToolExchange(): boolean {
    return this.pendingToolResultIds.size > 0;
  }

  /**
   * Remove stale entries from `pendingToolResultIds` and trim orphaned
   * assistant messages from `_history`.  This happens when a session is
   * killed mid-tool-call and later resumed — the tool.call events are
   * replayed but the tool.result events never arrived.  Without this
   * cleanup, `hasOpenToolExchange()` would remain true (deferring new
   * messages) and the orphaned assistant would still be sent to the
   * provider on the next turn, causing a 400 error.
   */
  cleanupOrphanedToolCalls(): void {
    // Clear stale pendingToolResultIds.
    this.pendingToolResultIds.clear();

    // Find assistant messages that have unanswered tool_calls.
    // Check positionally: a tool_call_id is "answered" only if there
    // is a tool result AFTER the assistant in history, before the next
    // assistant. This prevents false matches when toolCallIds are reused
    // across turns.
    const assistantsToRemove = new Set<number>();
    for (let i = 0; i < this._history.length; i++) {
      const message = this._history[i];
      if (message === undefined || message.role !== 'assistant' || message.toolCalls.length === 0) continue;

      const allAnswered = message.toolCalls.every((tc) => {
        for (let j = i + 1; j < this._history.length; j++) {
          const later = this._history[j];
          if (later !== undefined && later.role === 'tool' && later.toolCallId === tc.id) return true;
          if (later !== undefined && later.role === 'assistant') break;
        }
        return false;
      });

      if (!allAnswered) {
        assistantsToRemove.add(i);
      }
    }

    if (assistantsToRemove.size > 0) {
      // Build a set of indices to remove: each removed assistant AND all
      // tool messages that follow it (up to the next assistant or end of
      // history). This avoids globally removing tool messages by ID, which
      // could incorrectly remove valid tool results from earlier turns
      // when toolCallIds are reused.
      const indicesToRemove = new Set<number>();
      for (const idx of assistantsToRemove) {
        indicesToRemove.add(idx);
        // Remove tool messages after this assistant up to the next assistant.
        for (let j = idx + 1; j < this._history.length; j++) {
          const later = this._history[j];
          if (later !== undefined && later.role === 'assistant') break;
          if (later !== undefined && later.role === 'tool') {
            indicesToRemove.add(j);
          }
        }
      }

      const removedMessages = new Set<ContextMessage>();
      this._history = this._history.filter((message, index) => {
        if (indicesToRemove.has(index)) {
          removedMessages.add(message);
          return false;
        }
        return true;
      });
      // Also remove from replay builder so ResumeSessionResult doesn't
      // include stale orphaned messages.
      this.agent.replayBuilder.removeLastMessages(removedMessages);
    }

    // Flush any deferred messages that were blocked by the stale pending set.
    this.flushDeferredMessagesIfToolExchangeClosed();
  }

  private pushHistory(...messages: ContextMessage[]): void {
    this._history.push(...messages);
    for (const message of messages) {
      if (message.role === 'assistant') {
        this._lastAssistantAt = this.agent.records.restoring?.time ?? Date.now();
      }
      if (message.origin?.kind === 'background_task') {
        this.agent.background.markDeliveredNotification(message.origin);
      }
      this.agent.replayBuilder.push({
        type: 'message',
        message,
      });
    }
  }
}

function toolResultOutputForModel(result: ExecutableToolResult): string | ContentPart[] {
  const output = result.output;
  if (typeof output === 'string') {
    if (result.isError === true) {
      if (output.length === 0) return TOOL_EMPTY_ERROR_STATUS;
      if (output.trimStart().startsWith('<system>ERROR:')) return output;
      return `${TOOL_ERROR_STATUS}\n${output}`;
    }
    return isEmptyOutputText(output) ? TOOL_EMPTY_STATUS : output;
  }

  if (output.length === 0) {
    return [
      {
        type: 'text',
        text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS,
      },
    ];
  }
  if (result.isError === true) {
    return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...output];
  }
  return output;
}

function isEmptyOutputText(output: string): boolean {
  return output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}

function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation') {
    return origin.trigger === 'user-slash';
  }
  return false;
}

function formatUndoUnavailableMessage(
  requestedCount: number,
  undoableCount: number,
  stoppedAtCompaction: boolean,
): string {
  const reason = stoppedAtCompaction ? ' after the last compaction' : '';
  return `Cannot undo ${formatPromptCount(requestedCount)}; only ${formatPromptCount(undoableCount)} can be undone in the active context${reason}.`;

  function formatPromptCount(count: number): string {
    return `${String(count)} ${count === 1 ? 'prompt' : 'prompts'}`;
  }
}
