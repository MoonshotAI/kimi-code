import { createToolMessage, type ContentPart, type Message } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { ErrorCodes, KimiError } from '../../errors';
import type { ExecutableToolResult, LoopRecordedEvent } from '../../loop';
import { extractImageCompressionCaptions } from '../../tools/support/image-compress';
import { estimateTokens, estimateTokensForMessages } from '../../utils/tokens';
import { escapeXml } from '../../utils/xml-escape';
import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  COMPACTION_ELISION_VARIANT,
  buildCompactionElisionText,
  collectCompactableUserMessages,
  isRealUserInput,
  selectCompactionUserMessages,
  selectRecentUserMessages,
  type CompactionInput,
  type CompactionResult,
} from '../compaction';
import {
  project,
  type ProjectionAnomaly,
  type ProjectOptions,
  trimTrailingOpenToolExchange,
} from './projector';
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
const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

// Invariant: _history must not contain an unresolved tool call exchange except
// at the tail. When the tail is unresolved, pendingToolResultIds is exactly the
// set of missing tool result ids for that tail exchange; appendMessage keeps
// later messages in deferredMessages until those ids are resolved.
export class ContextMemory {
  private _history: ContextMessage[] = [];
  private _tokenCount = 0;
  private tokenCountCoveredMessageCount = 0;
  private openSteps: Map<string, ContextMessage> = new Map();
  private pendingToolResultIds = new Set<string>();
  private deferredMessages: ContextMessage[] = [];
  private _lastAssistantAt: number | null = null;
  // Signature of the last logged set of projection repairs, so a repair that
  // recurs identically on every send is logged once rather than per step.
  private lastProjectionRepairSignature: string | null = null;

  constructor(protected readonly agent: Agent) {}

  get lastAssistantAt(): number | null {
    return this._lastAssistantAt;
  }

  appendUserMessage(
    content: readonly ContentPart[],
    origin: PromptOrigin = USER_PROMPT_ORIGIN,
  ): void {
    if (content.length === 0) return;
    // Prompt ingestion (server upload/base64 route, TUI paste, ACP) annotates
    // a compressed image with an inline `<system>` caption next to the image.
    // Left inside the user message, that raw markup is user-visible in every
    // history projection (TUI replay, vis, export). Reroute each caption
    // through the built-in system-reminder injection — hidden by its
    // `injection` origin — and keep only the real user content here.
    const { captions, parts } =
      origin.kind === 'user'
        ? splitImageCompressionCaptions(content)
        : { captions: [], parts: [...content] };
    for (const caption of captions) {
      this.appendSystemReminder(caption, { kind: 'injection', variant: 'image_compression' });
    }
    if (parts.length === 0) return;
    this.appendMessage({
      role: 'user',
      content: parts,
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

  /**
   * Inject a user-invisible message and immediately send it to the model by
   * launching/steering a turn. The content is used as-is (no wrapper tag), so
   * callers can pass raw tool-result-style text or wrap it themselves. The
   * message is skipped on replay / transcript (so the user never sees it) but
   * is included in the context sent to the model. Use this for events the
   * model must react to right away without surfacing a user-visible message.
   */
  injectAndNotify(content: string, origin?: PromptOrigin): void {
    this.agent.turn.steer(
      [{ type: 'text', text: content }],
      origin ?? { kind: 'injection', variant: 'system_reminder' },
    );
  }

  appendLocalCommandStdout(content: string): void {
    const text = `<local-command-stdout>\n${content.trim()}\n</local-command-stdout>`;
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'local-command-stdout' },
    });
  }

  // User-initiated `!` shell command. Unlike `injection` (which is skipped on
  // replay), `shell_command` origin is replayed and rendered, so resumed
  // sessions still show the command and its output. The XML tags carry the
  // semantics to the model; the origin drives UI/replay routing.
  appendBashInput(command: string): void {
    const text = `<bash-input>\n${escapeXml(command)}\n</bash-input>`;
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'shell_command', phase: 'input' },
    });
  }

  appendBashOutput(stdout: string, stderr: string, isError?: boolean): void {
    const text = `<bash-stdout>${escapeXml(stdout)}</bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`;
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin:
        isError === true
          ? { kind: 'shell_command', phase: 'output', isError: true }
          : { kind: 'shell_command', phase: 'output' },
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

      if (isRealUserInput(message)) {
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

  applyCompaction(input: CompactionInput): CompactionResult {
    // Single derivation point for the post-compaction shape: the kept user
    // messages (verbatim, within the token budget — the oldest head plus the
    // most recent tail, with an elision marker between them when the pool
    // overflowed), followed by a user-role summary. `tokensAfter` and the
    // kept-count fields are derived here from the actual `_history` so the
    // live context, the wire record, and the transcript reducer all agree —
    // re-deriving them elsewhere (e.g. from the full transcript, which still
    // holds the untruncated originals of messages the live context truncated)
    // would diverge.
    const compactableUserMessages = collectCompactableUserMessages(this._history);
    // Records written before the head/tail split carry `keptUserMessageCount`
    // but no `keptHeadUserMessageCount`; they were produced by the tail-only
    // selection, so restore must reproduce that exact selection or the rebuilt
    // history would diverge from the persisted counts the transcript reducer
    // relies on. (A new-code record without elision restores identically under
    // either selection, so gating on the head field alone is sufficient.)
    const restoreTailOnly =
      this.agent.records.restoring !== null && input.keptHeadUserMessageCount === undefined;
    const selection = restoreTailOnly
      ? {
          head: [],
          tail: selectRecentUserMessages(compactableUserMessages, COMPACT_USER_MESSAGE_MAX_TOKENS),
          elided: false,
          omittedTokens: 0,
        }
      : selectCompactionUserMessages(compactableUserMessages);
    const elisionMessage: ContextMessage | null = selection.elided
      ? {
          role: 'user',
          content: [{ type: 'text', text: buildCompactionElisionText(selection.omittedTokens) }],
          toolCalls: [],
          origin: { kind: 'injection', variant: COMPACTION_ELISION_VARIANT },
        }
      : null;
    const keptMessages: ContextMessage[] =
      elisionMessage === null
        ? [...selection.head, ...selection.tail]
        : [...selection.head, elisionMessage, ...selection.tail];
    // Live compaction omits these so they are derived from the actual
    // `_history`; restore passes the persisted record so its historical values
    // are preserved verbatim. Older wire records did not have `contextSummary`,
    // so their `summary` remains the model-context text during restore.
    const contextSummary = input.contextSummary ?? input.summary;
    const tokensAfter =
      input.tokensAfter ??
      estimateTokens(contextSummary) + estimateTokensForMessages(keptMessages);
    const keptUserMessageCount =
      input.keptUserMessageCount ?? selection.head.length + selection.tail.length;
    const keptHeadUserMessageCount =
      input.keptHeadUserMessageCount ?? (selection.elided ? selection.head.length : undefined);
    const result: CompactionResult = {
      summary: input.summary,
      contextSummary,
      compactedCount: input.compactedCount,
      tokensBefore: input.tokensBefore,
      tokensAfter,
      keptUserMessageCount,
      keptHeadUserMessageCount,
      droppedCount: input.droppedCount,
    };
    this.agent.records.logRecord({
      type: 'context.apply_compaction',
      ...result,
    });
    this.agent.replayBuilder.patchLast('compaction', {
      result: {
        summary: result.summary,
        contextSummary: result.contextSummary,
        compactedCount: result.compactedCount,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        keptUserMessageCount: result.keptUserMessageCount,
        keptHeadUserMessageCount: result.keptHeadUserMessageCount,
        droppedCount: result.droppedCount,
      },
    });
    const summaryMessage: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: contextSummary }],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    };
    // Wire backward-compat: a pre-rework `context.apply_compaction` record (which
    // has no `keptUserMessageCount`) used `[summary, ...history.slice(compactedCount)]`
    // semantics and kept a verbatim recent tail. Reproduce that shape on restore
    // so resuming a session compacted by an older version does not silently drop
    // the recent assistant/tool tail beyond `compactedCount`. Gated on
    // `records.restoring`, so the live/forward path — which always sets
    // `contextSummary` and `keptUserMessageCount` — is unaffected.
    //
    // The cut can land inside a tool exchange, leaving the tail starting with an
    // orphan `tool` result whose assistant is now in the summarized prefix. The
    // history is kept faithful to the wire records (so the transcript reducer's
    // fold length stays in sync); the projector drops the orphan at the wire
    // boundary — see `dropOrphanToolResults` — so a strict provider still gets a
    // valid request without mutating the stored history here.
    const isLegacyRestore =
      this.agent.records.restoring !== null &&
      input.keptUserMessageCount === undefined &&
      input.compactedCount < this._history.length;
    this._history = isLegacyRestore
      ? [summaryMessage, ...this._history.slice(input.compactedCount)]
      : [...keptMessages, summaryMessage];
    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    // Drop deferred messages (mostly injections/system reminders) instead of
    // flushing them: initial context is rebuilt every turn.
    this.deferredMessages = [];
    this._tokenCount = result.tokensAfter;
    this.tokenCountCoveredMessageCount = this._history.length;
    this.agent.microCompaction.reset();
    this.agent.injection.onContextCompacted();
    this.agent.emitStatusUpdated();
    return result;
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

  project(messages: readonly ContextMessage[], options?: ProjectOptions): Message[] {
    const anomalies: ProjectionAnomaly[] = [];
    const result = project(this.agent.microCompaction.compact(messages), {
      ...options,
      onAnomaly: (anomaly) => {
        anomalies.push(anomaly);
        options?.onAnomaly?.(anomaly);
      },
    });
    this.reportProjectionRepairs(anomalies);
    return result;
  }

  // Surface the projector's wire-repairs so a silently-mangled history leaves a
  // trace instead of being papered over. Deduped by signature: a repair that
  // recurs identically every send (e.g. a persistently lost result re-synthesized
  // each turn) logs once, not per step. Trailing-tail synthesis is excluded — it
  // is the expected close of an in-flight call under `synthesizeMissing`
  // (compaction / strict resend), not a defect.
  private reportProjectionRepairs(anomalies: readonly ProjectionAnomaly[]): void {
    const notable = anomalies.filter(
      (anomaly) => !(anomaly.kind === 'tool_result_synthesized' && anomaly.trailing),
    );
    if (notable.length === 0) {
      this.lastProjectionRepairSignature = null;
      return;
    }
    const signature = notable
      .map((anomaly) => ('toolCallId' in anomaly ? `${anomaly.kind}:${anomaly.toolCallId}` : anomaly.kind))
      .toSorted()
      .join('|');
    if (signature === this.lastProjectionRepairSignature) return;
    this.lastProjectionRepairSignature = signature;

    let reordered = 0;
    let synthesized = 0;
    let droppedOrphan = 0;
    let duplicateCallsDropped = 0;
    let duplicateResultsDropped = 0;
    let leadingDropped = 0;
    let assistantsMerged = 0;
    let whitespaceDropped = 0;
    for (const anomaly of notable) {
      if (anomaly.kind === 'tool_result_reordered') reordered += 1;
      else if (anomaly.kind === 'tool_result_synthesized') synthesized += 1;
      else if (anomaly.kind === 'orphan_tool_result_dropped') droppedOrphan += 1;
      else if (anomaly.kind === 'duplicate_tool_call_dropped') duplicateCallsDropped += 1;
      else if (anomaly.kind === 'duplicate_tool_result_dropped') duplicateResultsDropped += 1;
      else if (anomaly.kind === 'leading_non_user_dropped') leadingDropped += 1;
      else if (anomaly.kind === 'consecutive_assistants_merged') assistantsMerged += 1;
      else whitespaceDropped += 1;
    }
    const toolCallIds = [
      ...new Set(
        notable.flatMap((anomaly) => ('toolCallId' in anomaly ? [anomaly.toolCallId] : [])),
      ),
    ].slice(0, 5);
    this.agent.log.warn('repaired the request to keep it wire-valid', {
      reordered,
      synthesized,
      droppedOrphan,
      duplicateCallsDropped,
      duplicateResultsDropped,
      leadingDropped,
      assistantsMerged,
      whitespaceDropped,
      toolCallIds,
    });
    this.agent.telemetry.track('context_projection_repaired', {
      reordered,
      synthesized,
      dropped_orphan: droppedOrphan,
      duplicate_calls_dropped: duplicateCallsDropped,
      duplicate_results_dropped: duplicateResultsDropped,
      leading_dropped: leadingDropped,
      assistants_merged: assistantsMerged,
      whitespace_dropped: whitespaceDropped,
    });
  }

  get messages(): Message[] {
    // The normal wire projection. `dropOrphanResults` is on for every
    // request-building projection (here, `strictMessages`, and the compaction
    // summarizer): a stray result with no matching call anywhere is wire-invalid
    // on strict providers and useless to the model, so it never reaches the
    // provider — while fragment projections (e.g. token estimation of a history
    // slice) leave it alone.
    return this.project(this.history, { dropOrphanResults: true });
  }

  // Last-resort projection for the post-400 strict resend: close every open tool
  // call (including a trailing in-flight one), drop stray tool results, dedupe
  // duplicate tool call ids (with their extra results), drop a leading non-user
  // message, and merge consecutive assistant turns, so the request is
  // wire-compliant for strict providers no matter how the history was mangled.
  // Only used when the provider has already rejected the normal projection —
  // see the adjacency fallback in `turn-step`.
  get strictMessages(): Message[] {
    return this.project(this.history, {
      synthesizeMissing: true,
      dropOrphanResults: true,
      dedupeDuplicateToolCalls: true,
      dropLeadingNonUser: true,
      mergeConsecutiveAssistants: true,
    });
  }

  useProjectedHistoryFrom(source: ContextMemory): void {
    this.clear();
    this.pushHistory(...trimTrailingOpenToolExchange(source.project(source.history)));
  }

  finishResume(): void {
    this.openSteps.clear();
    const closed = this.closePendingToolResults();
    if (closed.length > 0) {
      // Routine end-of-resume close of a genuinely interrupted trailing call
      // (e.g. the process died mid-tool), logged for traceability.
      this.agent.log.info('closed interrupted tool calls at end of resume', {
        closed: closed.length,
        toolCallIds: closed.slice(0, 5),
      });
    }
  }

  // Synthesize interrupted tool results for any still-open tool calls, closing
  // the exchange in place. Called at every replayed step boundary (see the
  // `step.begin` case) so a tool call left unresolved mid-history is closed
  // exactly where it occurred — otherwise it would keep `hasOpenToolExchange`
  // true and strand every later message in `deferredMessages`, so only the
  // trailing exchange ends up aligned. `finishResume` runs the same routine once
  // more to close a genuine trailing interruption at end of resume, and
  // `closeAbandonedToolExchange` reuses it (with a live-turn message) as the
  // turn-end teardown. Returns the ids it closed; callers own the logging.
  private closePendingToolResults(output: string = TOOL_INTERRUPTED_ON_RESUME_OUTPUT): string[] {
    if (this.pendingToolResultIds.size === 0) return [];
    const interruptedToolCallIds = [...this.pendingToolResultIds];
    for (const toolCallId of interruptedToolCallIds) {
      this.appendLoopEvent({
        type: 'tool.result',
        parentUuid: toolCallId,
        toolCallId,
        result: {
          output,
          isError: true,
        },
      });
    }
    return interruptedToolCallIds;
  }

  /**
   * Defensive teardown for a live turn that ended — normally, cancelled, or
   * failed — while recorded tool calls were still awaiting results (e.g. the
   * batch's result dispatch died after a `tool.call` was already recorded).
   * Synthesizes an error result for each dangling call so the exchange closes:
   * left open, it would keep `hasOpenToolExchange` true and strand every later
   * message in `deferredMessages`, silently swallowing user input. No-op when
   * the exchange is already closed. Returns the number of calls it closed.
   */
  closeAbandonedToolExchange(output: string): number {
    return this.closePendingToolResults(output).length;
  }

  appendLoopEvent(event: LoopRecordedEvent): void {
    this.agent.records.logRecord({
      type: 'context.append_loop_event',
      event,
    });
    switch (event.type) {
      case 'step.begin': {
        // A new assistant step means any tool calls still pending from an
        // earlier step were interrupted (the invariant guarantees this never
        // happens live, so this is a no-op outside replay). Close them in place
        // before opening the new step so mid-history gaps stay aligned.
        const closed = this.closePendingToolResults();
        if (closed.length > 0) {
          // A mid-history gap means results were lost before this boundary —
          // a genuine defect worth investigating, unlike the expected trailing
          // interruption `finishResume` closes.
          this.agent.log.warn('closed unresolved tool calls at a step boundary', {
            closed: closed.length,
            toolCallIds: closed.slice(0, 5),
          });
        }
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
          const coveredCount =
            openStepIndex === -1 ? this._history.length : openStepIndex + 1;
          const totalUsage =
            event.usage.inputCacheRead +
            event.usage.inputCacheCreation +
            event.usage.inputOther +
            event.usage.output;
          if (totalUsage > 0) {
            this._tokenCount = totalUsage;
          } else {
            // The provider reported zero usage (e.g. content filter). Do not
            // overwrite the accumulated context token count with 0; add an
            // estimate for the newly covered messages so the invariant between
            // _tokenCount and tokenCountCoveredMessageCount stays intact.
            const previousCoveredCount = this.tokenCountCoveredMessageCount;
            this._tokenCount += estimateTokensForMessages(
              this._history.slice(previousCoveredCount, coveredCount),
            );
          }
          this.tokenCountCoveredMessageCount = coveredCount;
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
        // Drop a result for an id that is not awaiting one: it was already
        // closed in place at a step boundary (a stale duplicate from an older
        // tail-only finishResume), or its call is gone.
        if (!this.pendingToolResultIds.has(event.toolCallId)) return;
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

  // Treat an array output with no sendable content (empty, or only empty/
  // whitespace-only text blocks) the same as an empty string output: emit the
  // placeholder. Otherwise projection would strip the blank text blocks, leave
  // the tool message empty, and throw on every send — bricking the session. A
  // non-text part (image/etc.) or any non-whitespace text keeps the real output.
  if (isEmptyEquivalentContentArray(output)) {
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

function isEmptyEquivalentContentArray(output: readonly ContentPart[]): boolean {
  return output.every((part) => part.type === 'text' && part.text.trim().length === 0);
}

// Split inline image-compression captions (see buildImageCompressionCaption)
// out of user prompt content. A caption may be a standalone text part (server
// route, ACP) or merged into an adjacent text segment (TUI paste), so each
// text part is scanned rather than matched whole. Text left empty once its
// captions are removed is dropped entirely.
function splitImageCompressionCaptions(content: readonly ContentPart[]): {
  captions: readonly string[];
  parts: ContentPart[];
} {
  const captions: string[] = [];
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type !== 'text') {
      parts.push(part);
      continue;
    }
    const extracted = extractImageCompressionCaptions(part.text);
    if (extracted.captions.length === 0) {
      parts.push(part);
      continue;
    }
    captions.push(...extracted.captions);
    if (extracted.text.trim().length > 0) {
      parts.push({ type: 'text', text: extracted.text });
    }
  }
  return { captions, parts };
}

function isEmptyOutputText(output: string): boolean {
  return output.trim().length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
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
