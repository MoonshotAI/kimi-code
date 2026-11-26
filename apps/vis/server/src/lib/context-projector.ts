import {
  buildContextCompactionShape,
} from '@moonshot-ai/agent-core-v2/agent/contextMemory/compactionHandoff';
import { readContextCompactionShapeInput } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextOps';
import { cutTurnUndo } from '@moonshot-ai/agent-core-v2/agent/undo/turnUndo';
import type { WireRecord } from '@moonshot-ai/agent-core-v2/wire/record';
import { createLoopEventFold } from '@moonshot-ai/agent-core-v2/agent/contextMemory/loopEventFold';
import { renderToolResultForModel } from '@moonshot-ai/agent-core-v2/agent/contextMemory/toolResultRender';
import type { ContentPart } from '@moonshot-ai/core/llm/message';
import type {
  ContextMessage,
  PermissionMode,
  TokenUsage,
  WireEntry,
} from './agent-record-types';

export interface ProjectedMessage {
  lineNo: number;
  time?: number;
  source: 'append_message' | 'compaction_summary' | 'undo' | 'clear';
  message: ContextMessage;
  toolStepUuids: string[];
  undo?: { count: number; removedMessageCount: number };
  compaction?: { compactedCount: number; tokensBefore?: number; tokensAfter?: number };
}

export interface UsageTotals {
  byScope: { session: TokenUsage; turn: TokenUsage; prediction: TokenUsage };
  byModel: Record<string, TokenUsage>;
}

export interface ConfigSnapshot {
  cwd?: string;
  modelAlias?: string;
  profileName?: string;
  thinkingEffort?: string;
  systemPrompt?: string;
}

export interface GoalSnapshot {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status?: string;
  actor?: string;
  reason?: string;
  tokensUsed?: number;
  turnsUsed?: number;
  wallClockMs?: number;
}

export interface ContextProjection {
  messages: ProjectedMessage[];
  usage: UsageTotals;
  contextTokens: number;
  config: ConfigSnapshot;
  permission: { mode: PermissionMode | null };
  planMode: { active: boolean; id?: string };
  goal: GoalSnapshot | null;
  swarm: { active: boolean; trigger?: string };
}

const ZERO: TokenUsage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };

/** Build a conversation timeline + derived state from a sequence of
 *  wire entries. The reconstruction mirrors the engine's own loop-event
 *  fold logic, so:
 *
 *  - `context.append_message` records become messages as-is (the
 *    user / tool messages and any explicit assistant injections).
 *  - `step.begin` settles a preceding attempt and opens a fresh assistant;
 *    later `content.part` and `tool.call` events on the same step grow that
 *    message. A `step.end` seals it (or drops it when vacuous), including
 *    interrupted and error endings.
 *  - pending tool calls defer appended messages; matching `tool.result`
 *    events close them, and an attempt that settles first gets synthetic
 *    interrupted results, exactly like engine replay.
 *
 *  Without this loop-event reconstruction the timeline would only
 *  show user prompts — the engine does not emit a synthetic
 *  `context.append_message` for assistant turns.
 *
 *  `mode` selects between two views of the four destructive lifecycle
 *  events (compaction / undo / clear / micro-compaction):
 *
 *  - `'model'` (default): faithfully mirrors what the model currently
 *    sees — compaction drops the compacted prefix, undo splices removed
 *    messages out, clear empties the list, micro-compaction blanks old
 *    tool results. All existing behaviour.
 *  - `'full'`: full reconstructed history for debugging — the same four
 *    events insert an INLINE MARKER but do NOT mutate/drop the message
 *    list, so messages compacted/undone/cleared away stay visible and
 *    micro-compacted tool results keep their original content.
 *
 *  Everything else (append_message, loop events, goal/swarm/permission/
 *  plan/config/usage/contextTokens derived state) is identical in both
 *  modes — `mode` only affects the `messages` array and which markers
 *  appear. */
export function projectContext(
  entries: ReadonlyArray<WireEntry>,
  mode: 'model' | 'full' = 'model',
): ContextProjection {
  let messages: ProjectedMessage[] = [];
  let modelMessages: ProjectedMessage[] = [];
  const usage: UsageTotals = {
    byScope: { session: { ...ZERO }, turn: { ...ZERO }, prediction: { ...ZERO } },
    byModel: {},
  };
  const config: ConfigSnapshot = {};
  let permissionMode: PermissionMode | null = null;
  let planActive = false;
  let planId: string | undefined;
  let contextTokens = 0;
  let goal: GoalSnapshot | null = null;
  let swarm: { active: boolean; trigger?: string } = { active: false };
  let microCutoff = 0;
  let currentEntry: WireEntry | undefined;
  let openMessage: ProjectedMessage | undefined;
  let syntheticToolOrdinal = 0;
  const appendMessageEntries = new WeakMap<ContextMessage, ProjectedMessage>();

  const pushModelMessage = (message: ProjectedMessage): void => {
    modelMessages.push(message);
    messages.push(message);
  };

  const removeModelMessage = (message: ProjectedMessage): void => {
    const modelIndex = modelMessages.indexOf(message);
    if (modelIndex !== -1) modelMessages.splice(modelIndex, 1);
    const displayIndex = messages.indexOf(message);
    if (displayIndex !== -1) messages.splice(displayIndex, 1);
  };

  const currentLineNo = (): number => currentEntry?.lineNo ?? 0;

  const fold = createLoopEventFold({
    openAssistant: (time) => {
      const event = currentEntry?.data;
      const stepUuid =
        event?.type === 'context.append_loop_event' && event.event.type === 'step.begin'
          ? event.event.uuid
          : undefined;
      openMessage = {
        lineNo: currentLineNo(),
        time,
        source: 'append_message',
        message: { role: 'assistant', content: [], toolCalls: [], partial: true },
        toolStepUuids: stepUuid === undefined ? [] : [stepUuid],
      };
      pushModelMessage(openMessage);
    },
    appendOpenContent: (part) => {
      if (openMessage === undefined) return;
      openMessage.message = {
        ...openMessage.message,
        content: [...openMessage.message.content, part],
      };
    },
    appendOpenToolCall: (call) => {
      if (openMessage === undefined || openMessage.message.role !== 'assistant') return;
      openMessage.message = {
        ...openMessage.message,
        toolCalls: [...openMessage.message.toolCalls, call],
      };
    },
    dropOpenAssistant: () => {
      if (openMessage === undefined) return;
      removeModelMessage(openMessage);
      openMessage = undefined;
    },
    sealOpenAssistant: () => {
      if (openMessage === undefined) return;
      openMessage.message = { ...openMessage.message, partial: undefined };
      openMessage = undefined;
    },
    pushToolMessage: (message, time) => {
      const event = currentEntry?.data;
      const directResult =
        event?.type === 'context.append_loop_event' && event.event.type === 'tool.result';
      const lineNo = directResult
        ? currentLineNo()
        : currentLineNo() - 0.25 - syntheticToolOrdinal++ / 1000;
      pushModelMessage({
        lineNo,
        time,
        source: 'append_message',
        message: modelFacingMessage(message),
        toolStepUuids: [],
      });
    },
    pushMessage: (message, time) => {
      const projected = appendMessageEntries.get(message) ?? {
        lineNo: currentLineNo(),
        time,
        source: 'append_message' as const,
        message,
        toolStepUuids: [],
      };
      projected.message = modelFacingMessage(message);
      pushModelMessage(projected);
    },
  });

  const resetFold = (): void => {
    fold.reset();
    openMessage = undefined;
  };

  for (const [entryIndex, entry] of entries.entries()) {
    currentEntry = entry;
    syntheticToolOrdinal = 0;
    const rec = entry.data;
    switch (rec.type) {
      case 'context.append_message': {
        const message = normalizeLegacyOrigin(rec.message);
        appendMessageEntries.set(message, {
          lineNo: entry.lineNo,
          time: rec.time,
          source: 'append_message',
          message,
          toolStepUuids: [],
        });
        fold.appendMessage(message, rec.time);
        break;
      }
      case 'context.append_loop_event': {
        const ev = rec.event;
        fold.loopEvent(ev, rec.time);
        if (ev.type === 'step.end') {
          if ('usage' in ev && ev.usage !== undefined) {
            const fill =
              ev.usage.inputCacheRead === undefined
                ? undefined
                : ev.usage.inputCacheRead +
                  ev.usage.inputCacheCreation +
                  ev.usage.inputOther +
                  ev.usage.output;
            if (fill !== undefined && fill > 0) contextTokens = fill;
          }
        }
        break;
      }
      case 'context.update_token_count':
        contextTokens = rec.tokenCount;
        break;
      case 'context.clear':
        resetFold();
        modelMessages = [];
        if (mode === 'model') {
          messages = [];
          microCutoff = 0;
        } else {
          messages.push({
            lineNo: entry.lineNo,
            time: rec.time,
            source: 'clear',
            message: { role: 'assistant', content: [], toolCalls: [] } as ContextMessage,
            toolStepUuids: [],
          });
        }
        contextTokens = 0;
        break;
      case 'context.apply_compaction': {
        let compactionInput: ReturnType<typeof readContextCompactionShapeInput>;
        try {
          compactionInput = readContextCompactionShapeInput(rec);
        } catch {
          break;
        }
        if (mode === 'full' && rec.keptUserMessageCount !== undefined) {
          fold.settle(rec.time);
        }
        const historyEntries = [...modelMessages];
        resetFold();
        const rawSummary = rec.summary;
        const contextSummary = 'contextSummary' in rec ? rec.contextSummary : undefined;
        const summaryText =
          typeof rawSummary === 'string'
            ? rawSummary
            : rawSummary !== undefined
              ? contextMessageText(rawSummary)
              : (contextSummary ?? '');
        const shape = buildContextCompactionShape(
          historyEntries.map((message) => message.message),
          compactionInput,
        );
        const compactedCount = shape.compactedCount;
        const summaryBubble: ProjectedMessage = {
          lineNo: entry.lineNo,
          time: rec.time,
          source: 'compaction_summary',
          message: {
            role: 'user',
            content: [{ type: 'text', text: summaryText }],
            toolCalls: [],
            origin: { kind: 'compaction_summary' },
          } as ContextMessage,
          toolStepUuids: [],
          compaction: {
            compactedCount,
            tokensBefore: rec.tokensBefore,
            tokensAfter: shape.tokensAfter,
          },
        };
        const legacyTail = rec.legacyTail === true || rec.keptUserMessageCount === undefined;
        const summaryIndex = legacyTail
          ? 0
          : shape.messages.findIndex((message) => message.origin?.kind === 'compaction_summary');
        const modelSummaryBubble: ProjectedMessage = {
          ...summaryBubble,
          message: modelFacingMessage(shape.messages[summaryIndex] ?? summaryBubble.message),
        };
        const available = new Set(historyEntries);
        let syntheticOrdinal = 0;
        modelMessages = shape.messages.map((message, index) => {
          if (index === summaryIndex) return modelSummaryBubble;
          const original = historyEntries.find(
            (candidate) => available.has(candidate) && candidate.message === message,
          );
          if (original !== undefined) {
            available.delete(original);
            return original;
          }
          syntheticOrdinal += 1;
          return {
            lineNo: entry.lineNo - 0.5 - syntheticOrdinal / 1000,
            time: rec.time,
            source: 'append_message',
            message: modelFacingMessage(message),
            toolStepUuids: [],
          };
        });
        if (mode === 'model') {
          messages = [...modelMessages];
        } else {
          messages.push(summaryBubble);
        }
        microCutoff = 0;
        contextTokens = shape.tokensAfter;
        break;
      }
      case 'usage.record': {
        const scope = rec.usageScope ?? 'session';
        addUsage(usage.byScope[scope], rec.usage);
        usage.byModel[rec.model] ??= { ...ZERO };
        addUsage(usage.byModel[rec.model]!, rec.usage);
        break;
      }
      case 'config.update': {
        if (rec.environmentDisclosure !== undefined)
          config.cwd = rec.environmentDisclosure.cwd;
        if (rec.modelAlias !== undefined) config.modelAlias = rec.modelAlias;
        if (rec.profileName !== undefined) config.profileName = rec.profileName;
        const effort = rec.thinkingEffort ?? rec.thinkingLevel;
        if (effort !== undefined) config.thinkingEffort = effort;
        if (rec.systemPrompt !== undefined) config.systemPrompt = rec.systemPrompt;
        break;
      }
      case 'profile.bind': {
        if (rec.environmentDisclosure !== undefined)
          config.cwd = rec.environmentDisclosure.cwd;
        if (rec.modelAlias !== undefined) config.modelAlias = rec.modelAlias;
        if (rec.profileName !== undefined) config.profileName = rec.profileName;
        config.thinkingEffort = rec.thinkingEffort;
        config.systemPrompt = rec.systemPrompt;
        break;
      }
      case 'permission.set_mode':
        permissionMode = rec.mode;
        break;
      case 'plan_mode.enter':
        planActive = true; planId = rec.id; break;
      case 'plan_mode.cancel':
      case 'plan_mode.exit':
        planActive = false; planId = undefined; break;
      case 'context.undo': {
        // Mirror the engine's turn-based undo: locate the requested turn start,
        // include an immediately preceding prompt-owned injection in the cut,
        // then remove projected messages from that Wire line onward. The UI adds
        // a marker afterwards. Only visible removal is gated on 'model' mode.
        const result = cutTurnUndo(
          entries.slice(0, entryIndex).map((candidate) => ({
            record: candidate.data as WireRecord,
            line: candidate.lineNo,
          })),
          new Set(),
          rec.count,
        );
        const applied = result.cut !== undefined;
        const removedMessageCount = applied
          ? modelMessages.filter((message) => message.lineNo > result.cut!.line).length
          : 0;
        if (applied) {
          const cutLine = result.cut!.line;
          modelMessages = modelMessages.filter((message) => message.lineNo <= cutLine);
          resetFold();
          if (mode === 'model') {
            messages = messages.filter((message) => message.lineNo <= cutLine);
          }
        }
        if (mode === 'model') {
          microCutoff = Math.min(microCutoff, modelMessages.length);
        }
        messages.push({
          lineNo: entry.lineNo,
          time: rec.time,
          source: 'undo',
          message: { role: 'assistant', content: [], toolCalls: [] } as ContextMessage,
          toolStepUuids: [],
          undo: { count: rec.count, removedMessageCount },
        });
        break;
      }
      case 'micro_compaction.apply':
        microCutoff = rec.cutoff;
        break;
      case 'goal.create':
        goal = {
          goalId: rec.goalId,
          objective: rec.objective,
          completionCriterion: rec.completionCriterion,
        };
        break;
      case 'goal.update':
        if (goal !== null) {
          const prev: GoalSnapshot = goal;
          goal = {
            ...prev,
            objective: rec.objective ?? prev.objective,
            status: rec.status ?? prev.status,
            actor: rec.actor ?? prev.actor,
            reason: rec.reason ?? prev.reason,
            tokensUsed: rec.tokensUsed ?? prev.tokensUsed,
            turnsUsed: rec.turnsUsed ?? prev.turnsUsed,
            wallClockMs: rec.wallClockMs ?? prev.wallClockMs,
          };
        }
        break;
      case 'goal.clear':
        goal = null;
        break;
      case 'swarm_mode.enter':
        swarm = { active: true, trigger: rec.trigger };
        break;
      case 'swarm_mode.exit':
        swarm = { active: false };
        break;
      case 'tower_mode.enter':
      case 'tower_mode.exit':
        break;
      case 'token_counting.measured':
      case 'token_counting.truncated':
      case 'token_counting.rebased':
      case 'token_counting.turn_recorded':
        contextTokens = rec.tokens;
        break;
      case 'metadata':
      case 'forked':
      case 'changeNotifier.snapshot':
      case 'turn.prompt':
      case 'turn.steer':
      case 'turn.cancel':
      case 'turn.ended':
      case 'turn.step.interrupted':
      case 'turn.step.retrying':
      case 'prompt.accepted':
      case 'prompt.aborted':
      case 'prompt.completed':
      case 'prompt.steered':
      case 'interaction.request':
      case 'interaction.resolved':
      case 'task.started':
      case 'task.terminated':
      case 'task.waitDelivered':
      case 'subagent.spawned':
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.cancelled':
      case 'cron.add':
      case 'cron.cursor':
      case 'cron.delete':
      case 'plan.revision':
      case 'plugin.session_start':
      case 'environment.set_binding':
      case 'staleGuard.recorded':
      case 'staleGuard.cleared':
      case 'interruptionReminder.recorded':
      case 'interruptionReminder.requested':
      case 'permission.record_approval_result':
      case 'full_compaction.begin':
      case 'full_compaction.cancel':
      case 'full_compaction.complete':
      case 'tools.register_user_tool':
      case 'tools.unregister_user_tool':
      case 'tools.set_active_tools':
      case 'tools.update_store':
      case 'tools.reset_active_tools':
      case 'llm.tools_snapshot':
      case 'llm.request':
      case 'mcp.tools_discovered':
      case 'tool_select.initialized':
      case 'tool_select.tools_changed':
      case 'mcp.server_failed':
      case 'mcp.server_failure_resolved':
      case 'file_history.checkpoint':
      case 'file_history.tracked':
      case 'auto_review.ancestry_recorded':
      case 'auto_review.decision':
        break;
      default: {
        const _exhaustive: never = rec;
        void _exhaustive;
        break;
      }
    }
  }

  if (mode === 'model' && microCutoff > 0) {
    let historyIndex = 0;
    for (const pm of messages) {
      if (!isHistoryEntry(pm)) continue;
      if (historyIndex >= microCutoff) break;
      historyIndex++;
      const m = pm.message;
      if (
        m.role === 'tool' &&
        m.toolCallId !== undefined &&
        estimateContentTokens(m.content) >= MICRO_MIN_CONTENT_TOKENS
      ) {
        pm.message = { ...m, content: [{ type: 'text', text: MICRO_TRUNCATED_MARKER }] };
      }
    }
  }

  return {
    messages,
    usage,
    contextTokens,
    config,
    permission: { mode: permissionMode },
    planMode: { active: planActive, id: planId },
    goal,
    swarm,
  };
}

function addUsage(into: TokenUsage, src: TokenUsage): void {
  (into as any).inputOther += src.inputOther;
  (into as any).output += src.output;
  (into as any).inputCacheRead += src.inputCacheRead;
  (into as any).inputCacheCreation += src.inputCacheCreation;
}

const MICRO_TRUNCATED_MARKER = '[Old tool result content cleared]';
const MICRO_MIN_CONTENT_TOKENS = 100;

function estimateTokens(text: string): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}

function estimateContentTokens(content: readonly ContentPart[]): number {
  let total = 0;
  for (const p of content) {
    if (p.type === 'text') total += estimateTokens(p.text);
    else if (p.type === 'think') total += estimateTokens(p.think);
  }
  return total;
}

function isHistoryEntry(pm: ProjectedMessage): boolean {
  return pm.source !== 'undo' && pm.source !== 'clear';
}

function modelFacingMessage(message: ContextMessage): ContextMessage {
  if (message.role !== 'tool') return message;
  return {
    ...message,
    content: renderToolResultForModel({
      output: message.content,
      isError: message.isError,
      note: message.note,
    }),
    note: undefined,
  };
}

function normalizeLegacyOrigin(message: ContextMessage): ContextMessage {
  const origin = message.origin as { readonly kind: string } | undefined;
  if (origin?.kind !== 'background_task') return message;
  return { ...message, origin: { ...origin, kind: 'task' } as ContextMessage['origin'] };
}

function contextMessageText(message: ContextMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
