import { readFile } from 'node:fs/promises';

import type { TokenUsage } from '@moonshot-ai/agent-core-v2';

import type { StepTiming, StepUsage } from '../../protocol/messages';
import {
  SystemIdAllocator,
  isUndoAnchorOrigin,
  isVisibleTurnOrigin,
  turnIdOf,
  turnOrdinalOf,
} from './ids';

export interface ContextRecord {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

export async function readWireRecords(wirePath: string): Promise<ContextRecord[]> {
  const raw = await readFile(wirePath, 'utf8');
  const lines = raw.split('\n');
  const records: ContextRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as ContextRecord);
    } catch (parseError) {
      if (i === lines.length - 1) break;
      throw new Error(`wire.jsonl: corrupted line ${i + 1} in ${wirePath}: ${String(parseError)}`, {
        cause: parseError,
      });
    }
  }
  return records;
}

export interface TimelineSeed {
  readonly timelineIds: string[];
  readonly systemCounts: ReadonlyMap<string, number>;
  readonly anchorTurnOrdinals: number[];
  readonly nextTurnId: number;
}

export function foldTimelineSeed(records: readonly ContextRecord[]): TimelineSeed {
  const timelineIds: string[] = [];
  const anchorTurnOrdinals: number[] = [];
  const sysIds = new SystemIdAllocator();
  let nextTurnId = 0;
  let currentTurn: number | undefined;
  const cancelledTurnIds = new Set<number>();
  const hiddenTurnIds = new Set<number>();
  const visibleTurnOrdinals = new Set<number>();
  const turnPromptIds = new Map<number, string>();
  const pendingAnchorTurnIds: number[] = [];
  const undoAnchors: { rawId: number }[] = [];
  let undoAnchorFloor = 0;
  const activeCancelTurnIds = new Set<number>();

  const skipCancelledTurnIds = (): void => {
    while (cancelledTurnIds.delete(nextTurnId)) {
      hiddenTurnIds.add(nextTurnId);
      nextTurnId += 1;
    }
  };

  const pushSystem = (subtype: string): void => {
    timelineIds.push(sysIds.next(subtype));
  };

  const skillMarkerCount = (origin: unknown): number => {
    const kind = (origin as { kind?: unknown } | null | undefined)?.kind;
    if (kind === 'user') {
      const activations = (origin as { skillActivations?: unknown } | null | undefined)
        ?.skillActivations;
      return Array.isArray(activations) ? activations.length : 0;
    }
    if (kind === 'skill_activation' || kind === 'plugin_command') return 1;
    return 0;
  };

  for (const record of records) {
    switch (record.type) {
      case 'turn.prompt': {
        skipCancelledTurnIds();
        const rawId = nextTurnId;
        nextTurnId += 1;
        const origin = record['origin'];
        const promptId = record['promptId'];
        if (typeof promptId === 'string') turnPromptIds.set(rawId, promptId);
        if (isUndoAnchorOrigin(origin)) {
          pendingAnchorTurnIds.push(rawId);
          anchorTurnOrdinals.push(rawId);
        }
        currentTurn = rawId;
        if (!isVisibleTurnOrigin(origin)) {
          hiddenTurnIds.add(rawId);
          break;
        }
        visibleTurnOrdinals.add(rawId);
        timelineIds.push(turnIdOf(rawId));
        for (let i = 0; i < skillMarkerCount(origin); i++) pushSystem('skill');
        break;
      }
      case 'context.append_message': {
        const message = record['message'] as
          | { id?: string; role?: string; origin?: unknown }
          | undefined;
        if (message?.role === 'assistant') {
          if (
            currentTurn === undefined ||
            hiddenTurnIds.has(currentTurn) ||
            !visibleTurnOrdinals.has(currentTurn)
          ) {
            const rawId = nextTurnId;
            nextTurnId += 1;
            visibleTurnOrdinals.add(rawId);
            timelineIds.push(turnIdOf(rawId));
            currentTurn = rawId;
          }
          break;
        }
        if (message?.role !== 'user' || !isUndoAnchorOrigin(message.origin)) break;
        const messageId = typeof message.id === 'string' ? message.id : undefined;
        const matchingIndex =
          messageId !== undefined
            ? pendingAnchorTurnIds.findIndex((turnId) => turnPromptIds.get(turnId) === messageId)
            : -1;
        const legacyIndex =
          matchingIndex < 0 && messageId !== undefined
            ? pendingAnchorTurnIds.findIndex((turnId) => !turnPromptIds.has(turnId))
            : -1;
        const matchedTurnId =
          matchingIndex >= 0
            ? pendingAnchorTurnIds.splice(matchingIndex, 1)[0]
            : legacyIndex >= 0
              ? pendingAnchorTurnIds.splice(legacyIndex, 1)[0]
              : messageId === undefined
                ? pendingAnchorTurnIds.shift()
                : undefined;
        if (matchedTurnId !== undefined && !turnPromptIds.has(matchedTurnId) && messageId !== undefined) {
          turnPromptIds.set(matchedTurnId, messageId);
        }
        undoAnchors.push({ rawId: matchedTurnId ?? nextTurnId });
        break;
      }
      case 'turn.ended': {
        const rawId = record['turnId'];
        if (typeof rawId !== 'number' || !Number.isInteger(rawId)) break;
        const pendingIndex = pendingAnchorTurnIds.indexOf(rawId);
        if (pendingIndex >= 0) pendingAnchorTurnIds.splice(pendingIndex, 1);
        break;
      }
      case 'turn.cancel': {
        const target = record['target'];
        const turnId = record['turnId'];
        if (target === 'queued' && typeof turnId === 'number' && turnId >= nextTurnId) {
          cancelledTurnIds.add(turnId);
          skipCancelledTurnIds();
          break;
        }
        if (
          target !== 'active' ||
          typeof turnId !== 'number' ||
          !Number.isInteger(turnId) ||
          turnId < 0 ||
          activeCancelTurnIds.has(turnId)
        ) {
          break;
        }
        activeCancelTurnIds.add(turnId);
        if (record['reason'] !== 'user_cancelled') break;
        pushSystem('interruption');
        break;
      }
      case 'context.undo': {
        const count = record['count'];
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) break;
        let firstUndone: number | undefined;
        for (let i = 0; i < count && undoAnchors.length > undoAnchorFloor; i++) {
          const anchor = undoAnchors.pop();
          if (anchor !== undefined) firstUndone = anchor.rawId;
        }
        if (firstUndone === undefined) break;
        const cut = timelineIds.findIndex((id) => {
          const ordinal = turnOrdinalOf(id);
          return ordinal !== undefined && ordinal >= firstUndone;
        });
        if (cut < 0) break;
        timelineIds.length = cut;
        for (let turnId = firstUndone; turnId < nextTurnId; turnId++) hiddenTurnIds.add(turnId);
        if (currentTurn !== undefined && currentTurn >= firstUndone) currentTurn = undefined;
        pushSystem('undo');
        break;
      }
      case 'context.clear': {
        timelineIds.length = 0;
        undoAnchorFloor = undoAnchors.length;
        currentTurn = undefined;
        pushSystem('clear');
        break;
      }
      case 'context.apply_compaction': {
        undoAnchorFloor = undoAnchors.length;
        pushSystem('compaction');
        break;
      }
      case 'goal.create':
      case 'goal.clear': {
        pushSystem('goal');
        break;
      }
      case 'goal.update': {
        if (
          record['status'] === undefined &&
          record['budgetLimits'] === undefined &&
          record['turnsUsed'] === undefined
        ) {
          break;
        }
        pushSystem('goal');
        break;
      }
      case 'plan_mode.enter': {
        pushSystem('plan.enter');
        break;
      }
      case 'plan_mode.exit': {
        pushSystem('plan.exit');
        break;
      }
      case 'plan.revision': {
        pushSystem('plan.revision');
        break;
      }
      case 'swarm_mode.enter': {
        pushSystem('swarm.enter');
        break;
      }
      case 'swarm_mode.exit': {
        pushSystem('swarm.exit');
        break;
      }
      default:
        break;
    }
  }
  return {
    timelineIds,
    systemCounts: sysIds.counts(),
    anchorTurnOrdinals,
    nextTurnId,
  };
}

export interface WireStepFold {
  readonly state: 'completed' | 'interrupted';
  readonly endedAt?: string;
  readonly usage?: StepUsage;
  readonly finishReason?: string;
  readonly timing?: StepTiming;
  readonly endReason?: string;
  readonly endMessage?: string;
}

export interface WireToolFold {
  readonly step: number;
  readonly name: string;
  readonly args: unknown;
  readonly output?: unknown;
  readonly isError?: boolean;
}

export interface WireTurnFold {
  readonly steps: Map<number, WireStepFold>;
  readonly texts: Map<number, { assistant: string; thinking: string; first: 'assistant' | 'thinking' }>;
  readonly tools: Map<string, WireToolFold>;
}

interface StepRef {
  readonly turn: number;
  readonly step: number;
}

export function foldWireTurn(records: readonly ContextRecord[], turnOrdinal: number): WireTurnFold {
  const steps = new Map<number, WireStepFold>();
  const texts = new Map<
    number,
    { assistant: string; thinking: string; first: 'assistant' | 'thinking' }
  >();
  const tools = new Map<string, WireToolFold>();
  const stepRefs = new Map<string, StepRef>();
  const stepOf = (uuid: string | undefined): StepRef | undefined =>
    uuid === undefined ? undefined : stepRefs.get(uuid);
  for (const record of records) {
    if (record.type === 'context.append_loop_event') {
      const event = record['event'] as { type?: string } | undefined;
      if (event?.type === undefined) continue;
      switch (event.type) {
        case 'step.begin': {
          const e = event as { uuid: string; turnId?: string; step?: number };
          if (e.turnId === undefined || e.step === undefined) continue;
          const turn = Number(e.turnId);
          if (!Number.isInteger(turn)) continue;
          stepRefs.set(e.uuid, { turn, step: e.step });
          continue;
        }
        case 'step.end': {
          const e = event as {
            uuid: string;
            finishReason?: string;
            rawFinishReason?: string;
            providerFinishReason?: string;
            usage?: TokenUsage;
            llmFirstTokenLatencyMs?: number;
            llmStreamDurationMs?: number;
          };
          const ref = stepOf(e.uuid);
          if (ref === undefined || ref.turn !== turnOrdinal) continue;
          steps.set(ref.step, {
            state: 'completed',
            endedAt: record.time === undefined ? undefined : new Date(record.time).toISOString(),
            usage: e.usage === undefined ? undefined : toSnakeUsage(e.usage),
            finishReason: e.finishReason ?? e.rawFinishReason ?? e.providerFinishReason,
            timing:
              e.llmFirstTokenLatencyMs === undefined && e.llmStreamDurationMs === undefined
                ? undefined
                : {
                    llm_first_token_ms: e.llmFirstTokenLatencyMs,
                    llm_stream_duration_ms: e.llmStreamDurationMs,
                  },
          });
          continue;
        }
        case 'content.part': {
          const e = event as {
            stepUuid: string;
            part: { type: string; text?: string; think?: string };
            turnId?: string;
            step?: number;
          };
          let ref = stepOf(e.stepUuid);
          if (ref === undefined && e.turnId !== undefined && e.step !== undefined) {
            const turn = Number(e.turnId);
            if (Number.isInteger(turn)) ref = { turn, step: e.step };
          }
          if (ref === undefined || ref.turn !== turnOrdinal) continue;
          const entry = texts.get(ref.step) ?? { assistant: '', thinking: '', first: 'assistant' as const };
          if (e.part.type === 'text' && typeof e.part.text === 'string') {
            if (entry.assistant.length === 0 && entry.thinking.length === 0) entry.first = 'assistant';
            entry.assistant += e.part.text;
          } else if (e.part.type === 'think' && typeof e.part.think === 'string') {
            if (entry.assistant.length === 0 && entry.thinking.length === 0) entry.first = 'thinking';
            entry.thinking += e.part.think;
          } else {
            continue;
          }
          texts.set(ref.step, entry);
          continue;
        }
        case 'tool.call': {
          const e = event as {
            stepUuid: string;
            toolCallId: string;
            name: string;
            args?: unknown;
            turnId?: string;
            step?: number;
          };
          let ref = stepOf(e.stepUuid);
          if (ref === undefined && e.turnId !== undefined && e.step !== undefined) {
            const turn = Number(e.turnId);
            if (Number.isInteger(turn)) ref = { turn, step: e.step };
          }
          if (ref === undefined || ref.turn !== turnOrdinal) continue;
          tools.set(e.toolCallId, {
            step: ref.step,
            name: e.name,
            args: e.args,
            output: tools.get(e.toolCallId)?.output,
            isError: tools.get(e.toolCallId)?.isError,
          });
          continue;
        }
        case 'tool.result': {
          const e = event as {
            toolCallId: string;
            result: { output: unknown; isError?: boolean };
          };
          const existing = tools.get(e.toolCallId);
          if (existing === undefined) continue;
          tools.set(e.toolCallId, {
            ...existing,
            output: e.result.output,
            isError: e.result.isError,
          });
          continue;
        }
        default:
          continue;
      }
    }
    if (record.type === 'turn.step.interrupted') {
      if (record['turnId'] !== turnOrdinal) continue;
      const step = record['step'];
      if (typeof step !== 'number') continue;
      steps.set(step, {
        state: 'interrupted',
        endedAt: record.time === undefined ? undefined : new Date(record.time).toISOString(),
        endReason: typeof record['reason'] === 'string' ? record['reason'] : undefined,
        endMessage: typeof record['message'] === 'string' ? record['message'] : undefined,
      });
      continue;
    }
  }
  return { steps, texts, tools };
}

function toSnakeUsage(usage: TokenUsage): StepUsage {
  return {
    input_other: usage.inputOther,
    output: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}
