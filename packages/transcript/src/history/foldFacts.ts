import type { AgentRef } from '../model/frame';
import type { TranscriptInteraction } from '../model/interaction';
import type { TranscriptItem, TranscriptMarker } from '../model/item';
import { turnId as exportTurnKey } from '../model/ids';
import type { TranscriptStep, TranscriptTurn } from '../model/turn';
import type { AgentTranscriptSnapshot } from '../ops/operation';

export interface HistoryWireRecord {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

interface InteractionRequestPayload {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly toolCallId?: unknown;
  readonly request?: unknown;
}

interface InteractionResolvedPayload {
  readonly id?: unknown;
  readonly response?: unknown;
}

interface PlanRevisionPayload {
  readonly id?: unknown;
  readonly version?: unknown;
  readonly key?: unknown;
  readonly path?: unknown;
  readonly sha256?: unknown;
  readonly bytes?: unknown;
}

interface TurnEndedPayload {
  readonly turnId?: unknown;
  readonly reason?: unknown;
  readonly error?: unknown;
  readonly durationMs?: unknown;
}

interface TurnStepInterruptedPayload {
  readonly turnId?: unknown;
  readonly step?: unknown;
  readonly reason?: unknown;
  readonly message?: unknown;
}

interface TurnPromptPayload {
  readonly origin?: unknown;
  readonly promptId?: unknown;
  readonly turnId?: unknown;
}
interface ContextUndoPayload {
  readonly count?: unknown;
}
interface ContextAppendMessagePayload {
  readonly message?: {
    readonly id?: unknown;
    readonly role?: unknown;
    readonly origin?: unknown;
  };
}
interface TurnCancelPayload {
  readonly turnId?: unknown;
  readonly target?: unknown;
  readonly reason?: unknown;
}

function isUndoAnchorTurnOrigin(origin: unknown): boolean {
  const payload = origin as { kind?: unknown; trigger?: unknown } | undefined;
  if (payload?.kind === undefined || payload.kind === 'user') return true;
  return (
    (payload.kind === 'skill_activation' || payload.kind === 'plugin_command') &&
    payload.trigger === 'user-slash'
  );
}

function turnOriginKind(origin: unknown): TranscriptTurn['origin']['kind'] {
  const payload = origin as { kind?: unknown; taskId?: unknown } | undefined;
  switch (payload?.kind) {
    case 'user':
    case 'shell_command':
      return 'user';
    case 'cron_job':
    case 'cron_missed':
      return 'cron';
    case 'task':
    case 'background_task':
      return typeof payload.taskId === 'string' ? 'task' : 'other';
    case 'hook_result':
      return 'hook';
    case 'compaction_summary':
      return 'compaction';
    default:
      return 'other';
  }
}

function mapInteractionEndState(
  kind: TranscriptInteraction['interactionKind'],
  response: unknown,
): TranscriptInteraction['state'] {
  if (isEngineCancellation(response)) return 'cancelled';
  if (kind === 'question') return response === null ? 'dismissed' : 'answered';
  const decision = (response as { decision?: unknown } | null | undefined)?.decision;
  if (decision === 'approved' || decision === 'rejected' || decision === 'cancelled') {
    return decision;
  }
  return 'cancelled';
}

function isEngineCancellation(response: unknown): boolean {
  if (typeof response !== 'object' || response === null) return false;
  const { cancelled, reason } = response as { cancelled?: unknown; reason?: unknown };
  return cancelled === true && (reason === 'turn_ended' || reason === 'agent_closed');
}

function mapTurnEndReason(reason: unknown): TranscriptTurn['state'] | undefined {
  switch (reason) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'blocked':
      return 'failed';
    default:
      return undefined;
  }
}

function readTurnErrorMessage(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function recordTimeIso(record: HistoryWireRecord): string | undefined {
  const time: unknown = record.time;
  if (typeof time === 'number' && Number.isFinite(time)) return new Date(time).toISOString();
  if (typeof time === 'string') return time;
  return undefined;
}

function payloadOf(record: HistoryWireRecord): Record<string, unknown> {
  const { type: _type, time: _time, ...payload } = record;
  return payload;
}

export function foldWireRecordFacts(
  records: Iterable<HistoryWireRecord>,
  base: AgentTranscriptSnapshot,
  options?: {
    readonly agentId?: string;
    readonly resolvePlanRevisionKey?: (key: string) => string;
    readonly activeWireTurnId?: number;
  },
): AgentTranscriptSnapshot {
  const materializedTurnIds = new Set<number>();
  let currentTurnId: number | undefined;
  const interactions = new Map<string, TranscriptInteraction>();
  const endedTurns = new Map<number, HistoryWireRecord>();
  const interruptedSteps = new Map<number, Map<number, HistoryWireRecord>>();
  const turnPromptIds = new Map<number, string>();
  const turnOrigins = new Map<number, unknown>();
  const turnStartedTimes = new Map<number, string>();
  const turnPromptTimes = new Map<number, string>();
  let hasExplicitTurnId = false;
  let nextTurnId = 0;
  const cancelledTurnIds = new Set<number>();
  const hiddenTurnIds = new Set<number>();
  const undoAnchors: { firstRawTurnId: number }[] = [];
  const pendingUndoAnchorTurnIds: number[] = [];
  let undoAnchorFloor = 0;
  const skipCancelledTurnIds = (): void => {
    while (cancelledTurnIds.delete(nextTurnId)) {
      hiddenTurnIds.add(nextTurnId);
      nextTurnId += 1;
    }
  };

  const appended: TranscriptItem[] = [];
  const activeCancelTurnIds = new Set<number>();
  let markerSeq = 0;
  for (const item of base.items) {
    if (item.kind !== 'marker') continue;
    const match = /^m(\d+)$/.exec(item.markerId);
    if (match !== null) markerSeq = Math.max(markerSeq, Number(match[1]));
  }
  const pushMarker = (marker: string, record: HistoryWireRecord): void => {
    markerSeq += 1;
    const item: TranscriptMarker = {
      kind: 'marker',
      markerId: `m${markerSeq}`,
      marker,
      payload: payloadOf(record),
      at: recordTimeIso(record),
    };
    appended.push(item);
  };

  const subagentRefs = new Map<string, Map<string, { ref: AgentRef; index?: number }>>();

  for (const record of records) {
    switch (record.type) {
      case 'subagent.spawned': {
        if (options?.agentId !== undefined && record['parentAgentId'] !== options.agentId) break;
        const agentId = record['subagentId'];
        const toolCallId = record['parentToolCallId'];
        if (typeof agentId !== 'string' || typeof toolCallId !== 'string') break;
        const index = typeof record['swarmIndex'] === 'number' ? record['swarmIndex'] : undefined;
        const refs = subagentRefs.get(toolCallId) ?? new Map();
        refs.set(agentId, { ref: { agentId, role: index === undefined ? 'child' : 'member' }, index });
        subagentRefs.set(toolCallId, refs);
        break;
      }
      case 'goal.create':
      case 'goal.update': {
        pushMarker('goal', record);
        break;
      }
      case 'plan_mode.enter': {
        pushMarker('plan.enter', record);
        break;
      }
      case 'plan_mode.exit':
      case 'plan_mode.cancel': {
        pushMarker('plan.exit', record);
        break;
      }
      case 'plan.revision': {
        const payload = record as PlanRevisionPayload;
        const path =
          typeof payload.key === 'string'
            ? (options?.resolvePlanRevisionKey?.(payload.key) ?? payload.key)
            : typeof payload.path === 'string'
              ? payload.path
              : undefined;
        if (path === undefined) {
          pushMarker('plan.revision', record);
        } else {
          const { key: _key, ...rest } = record;
          pushMarker('plan.revision', { ...rest, path });
        }
        break;
      }
      case 'swarm_mode.enter': {
        pushMarker('swarm.enter', record);
        break;
      }
      case 'swarm_mode.exit': {
        pushMarker('swarm.exit', record);
        break;
      }
      case 'turn.cancel': {
        const payload = record as TurnCancelPayload;
        if (
          payload.target === 'queued' &&
          typeof payload.turnId === 'number' &&
          payload.turnId >= nextTurnId
        ) {
          cancelledTurnIds.add(payload.turnId);
          skipCancelledTurnIds();
          break;
        }
        if (
          payload.target !== 'active' ||
          typeof payload.turnId !== 'number' ||
          !Number.isInteger(payload.turnId) ||
          payload.turnId < 0 ||
          activeCancelTurnIds.has(payload.turnId)
        ) {
          break;
        }
        activeCancelTurnIds.add(payload.turnId);
        if (payload.reason !== 'user_cancelled') break;
        pushMarker('interruption', record);
        break;
      }
      case 'context.undo': {
        const count = (record as ContextUndoPayload).count;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) break;
        let firstUndoneTurnId: number | undefined;
        for (let i = 0; i < count && undoAnchors.length > undoAnchorFloor; i++) {
          const anchor = undoAnchors.pop();
          if (anchor !== undefined) firstUndoneTurnId = anchor.firstRawTurnId;
        }
        if (firstUndoneTurnId !== undefined) {
          for (let turnId = firstUndoneTurnId; turnId < nextTurnId; turnId++) {
            hiddenTurnIds.add(turnId);
          }
        }
        currentTurnId = undefined;
        break;
      }
      case 'context.clear':
      case 'context.apply_compaction': {
        undoAnchorFloor = undoAnchors.length;
        currentTurnId = undefined;
        break;
      }
      case 'context.append_message': {
        const message = (record as ContextAppendMessagePayload).message;
        const originKind = (message?.origin as { kind?: unknown } | undefined)?.kind;
        if (
          currentTurnId !== undefined &&
          message?.role === 'user' &&
          originKind !== 'injection' &&
          originKind !== 'compaction_summary'
        ) {
          materializedTurnIds.add(currentTurnId);
        }
        if (message?.role !== 'user' || !isUndoAnchorTurnOrigin(message.origin)) break;
        const matchingIndex =
          typeof message.id === 'string'
            ? pendingUndoAnchorTurnIds.findIndex(
                (turnId) => turnPromptIds.get(turnId) === message.id,
              )
            : -1;
        const legacyIndex =
          matchingIndex < 0 && typeof message.id === 'string'
            ? pendingUndoAnchorTurnIds.findIndex((turnId) => !turnPromptIds.has(turnId))
            : -1;
        const matchedTurnId =
          matchingIndex >= 0
            ? pendingUndoAnchorTurnIds.splice(matchingIndex, 1)[0]
            : legacyIndex >= 0
              ? pendingUndoAnchorTurnIds.splice(legacyIndex, 1)[0]
              : typeof message.id !== 'string'
                ? pendingUndoAnchorTurnIds.shift()
                : undefined;
        if (
          matchedTurnId !== undefined &&
          !turnPromptIds.has(matchedTurnId) &&
          typeof message.id === 'string'
        ) {
          turnPromptIds.set(matchedTurnId, message.id);
        }
        undoAnchors.push({ firstRawTurnId: matchedTurnId ?? nextTurnId });
        break;
      }
      case 'interaction.request': {
        const payload = record as InteractionRequestPayload;
        if (payload.kind !== 'approval' && payload.kind !== 'question') break;
        if (typeof payload.id !== 'string') break;
        const requestToolCallId = (payload.request as { toolCallId?: unknown } | undefined)
          ?.toolCallId;
        const toolCallId =
          typeof payload.toolCallId === 'string'
            ? payload.toolCallId
            : typeof requestToolCallId === 'string'
              ? requestToolCallId
              : undefined;
        interactions.set(payload.id, {
          interactionId: payload.id,
          interactionKind: payload.kind,
          toolCallId,
          state: 'pending',
          request: payload.request,
        });
        break;
      }
      case 'interaction.resolved': {
        const payload = record as InteractionResolvedPayload;
        if (typeof payload.id !== 'string') break;
        const entity = interactions.get(payload.id);
        if (entity === undefined) break;
        interactions.set(payload.id, {
          ...entity,
          state: mapInteractionEndState(entity.interactionKind, payload.response),
          response: payload.response,
        });
        break;
      }
      case 'turn.ended': {
        const payload = record as TurnEndedPayload;
        if (typeof payload.turnId === 'number') {
          endedTurns.set(payload.turnId, record);
          const pendingIndex = pendingUndoAnchorTurnIds.indexOf(payload.turnId);
          if (pendingIndex >= 0) pendingUndoAnchorTurnIds.splice(pendingIndex, 1);
          if (currentTurnId === payload.turnId) currentTurnId = undefined;
        }
        break;
      }
      case 'agent.turn.started': {
        const turnId = record['turnId'];
        const at = recordTimeIso(record);
        if (typeof turnId === 'number' && Number.isInteger(turnId) && at !== undefined) {
          turnStartedTimes.set(turnId, at);
          materializedTurnIds.add(turnId);
          currentTurnId = turnId;
        }
        break;
      }
      case 'turn.step.interrupted': {
        const payload = record as TurnStepInterruptedPayload;
        if (
          typeof payload.turnId !== 'number' ||
          typeof payload.step !== 'number' ||
          typeof payload.reason !== 'string'
        ) {
          break;
        }
        let steps = interruptedSteps.get(payload.turnId);
        if (steps === undefined) {
          steps = new Map();
          interruptedSteps.set(payload.turnId, steps);
        }
        steps.set(payload.step, record);
        break;
      }
      case 'turn.prompt': {
        skipCancelledTurnIds();
        const payload = record as TurnPromptPayload;
        const turnId = typeof payload.turnId === 'number' ? payload.turnId : nextTurnId;
        hasExplicitTurnId ||= typeof payload.turnId === 'number';
        currentTurnId = turnId;
        nextTurnId = Math.max(nextTurnId, turnId + 1);
        turnOrigins.set(turnId, payload.origin);
        const promptAt = recordTimeIso(record);
        if (promptAt !== undefined) turnPromptTimes.set(turnId, promptAt);
        if (typeof payload.promptId === 'string') turnPromptIds.set(turnId, payload.promptId);
        if (isUndoAnchorTurnOrigin(payload.origin)) pendingUndoAnchorTurnIds.push(turnId);
        break;
      }
      default:
        break;
    }
  }

  for (const [id, entity] of interactions) {
    if (entity.state === 'pending') {
      interactions.set(id, { ...entity, state: 'cancelled' });
    }
  }

  const baseTurns = base.items.filter((item): item is TranscriptTurn => item.kind === 'turn');
  const ordinalByPromptId = new Map(
    baseTurns.flatMap((turn) =>
      turn.triggerPromptId === undefined ? [] : [[turn.triggerPromptId, turn.ordinal] as const],
    ),
  );
  const claimedOrdinals = new Set<number>();
  const ordinalByRawTurnId = new Map<number, number>();
  const claimBaseOrdinal = (
    predicate: (turn: TranscriptTurn) => boolean = () => true,
  ): number | undefined => {
    const turn = baseTurns.find(
      (candidate) =>
        !claimedOrdinals.has(candidate.ordinal) &&
        predicate(candidate),
    );
    if (turn === undefined) return undefined;
    claimedOrdinals.add(turn.ordinal);
    return turn.ordinal;
  };
  const lastRawTurnId = Math.max(nextTurnId - 1, ...endedTurns.keys(), ...interruptedSteps.keys());
  const rawTurnIds = Array.from(
    { length: lastRawTurnId + 1 },
    (_, turnId) => turnId,
  ).filter(
    (turnId) =>
      !hiddenTurnIds.has(turnId) &&
      (!hasExplicitTurnId ||
        turnOrigins.has(turnId) ||
        endedTurns.has(turnId) ||
        interruptedSteps.has(turnId)),
  );
  for (const turnId of rawTurnIds) {
    const promptId = turnPromptIds.get(turnId);
    const matchedOrdinal = promptId === undefined ? undefined : ordinalByPromptId.get(promptId);
    if (matchedOrdinal !== undefined && !claimedOrdinals.has(matchedOrdinal)) {
      claimedOrdinals.add(matchedOrdinal);
      ordinalByRawTurnId.set(turnId, matchedOrdinal);
    }
  }
  for (const turnId of rawTurnIds) {
    if (ordinalByRawTurnId.has(turnId)) continue;
    const origin = turnOrigins.get(turnId);
    const strictOrigin = turnOrigins.has(turnId) && !isUndoAnchorTurnOrigin(origin);
    if (!strictOrigin) continue;
    const fallbackOrdinal = claimBaseOrdinal(
      (candidate) =>
        candidate.triggerPromptId === undefined &&
        candidate.origin.kind === turnOriginKind(origin),
    );
    if (fallbackOrdinal !== undefined) ordinalByRawTurnId.set(turnId, fallbackOrdinal);
  }
  for (const turnId of rawTurnIds) {
    if (ordinalByRawTurnId.has(turnId)) continue;
    const promptId = turnPromptIds.get(turnId);
    const origin = turnOrigins.get(turnId);
    const strictOrigin = turnOrigins.has(turnId) && !isUndoAnchorTurnOrigin(origin);
    if (promptId === undefined || strictOrigin) continue;
    const emptyPromptOrdinal = claimBaseOrdinal(
      (candidate) =>
        candidate.triggerPromptId === undefined && candidate.origin.kind === 'other',
    );
    if (emptyPromptOrdinal !== undefined) {
      ordinalByRawTurnId.set(turnId, emptyPromptOrdinal);
    }
  }
  for (const turnId of rawTurnIds) {
    if (ordinalByRawTurnId.has(turnId)) continue;
    const promptId = turnPromptIds.get(turnId);
    const origin = turnOrigins.get(turnId);
    const strictOrigin = turnOrigins.has(turnId) && !isUndoAnchorTurnOrigin(origin);
    if (promptId !== undefined || strictOrigin) continue;
    const fallbackOrdinal = claimBaseOrdinal();
    if (fallbackOrdinal !== undefined) ordinalByRawTurnId.set(turnId, fallbackOrdinal);
  }

  const endedByOrdinal = new Map<number, HistoryWireRecord>();
  for (const [turnId, record] of endedTurns) {
    const ordinal = ordinalByRawTurnId.get(turnId);
    if (ordinal !== undefined) endedByOrdinal.set(ordinal, record);
  }

  const interruptedByOrdinal = new Map<number, Map<number, HistoryWireRecord>>();
  for (const [turnId, steps] of interruptedSteps) {
    const ordinal = ordinalByRawTurnId.get(turnId);
    if (ordinal !== undefined) interruptedByOrdinal.set(ordinal, steps);
  }

  const items =
    endedByOrdinal.size > 0 || interruptedByOrdinal.size > 0
      ? base.items.map((item) => {
          if (item.kind !== 'turn') return item;
          const record = endedByOrdinal.get(item.ordinal);
          const interrupted = interruptedByOrdinal.get(item.ordinal);
          if (record === undefined && interrupted === undefined) return item;
          const steps = ((): TranscriptTurn['steps'] => {
            if (interrupted === undefined) return item.steps;
            const hitOrdinals = new Set<number>();
            const patched = item.steps.map((step) => {
              const hit = interrupted.get(step.ordinal);
              if (hit === undefined) return step;
              const stepPayload = hit as TurnStepInterruptedPayload;
              if (typeof stepPayload.reason !== 'string') return step;
              hitOrdinals.add(step.ordinal);
              return {
                ...step,
                state: 'interrupted' as const,
                endedAt: recordTimeIso(hit) ?? step.endedAt,
                endReason: stepPayload.reason,
                endMessage:
                  typeof stepPayload.message === 'string' ? stepPayload.message : undefined,
              };
            });
            for (const [stepOrdinal, hit] of interrupted) {
              if (hitOrdinals.has(stepOrdinal)) continue;
              const stepPayload = hit as TurnStepInterruptedPayload;
              if (typeof stepPayload.reason !== 'string') continue;
              patched.push({
                kind: 'step',
                stepId: `${item.turnId}.${stepOrdinal}`,
                turnId: item.turnId,
                ordinal: stepOrdinal,
                state: 'interrupted',
                frames: [],
                endedAt: recordTimeIso(hit),
                endReason: stepPayload.reason,
                endMessage:
                  typeof stepPayload.message === 'string' ? stepPayload.message : undefined,
              });
            }
            return patched.toSorted((a, b) => a.ordinal - b.ordinal);
          })();
          if (record === undefined) return { ...item, steps };
          const payload = record as TurnEndedPayload;
          return {
            ...item,
            steps,
            state: mapTurnEndReason(payload.reason) ?? item.state,
            endedAt: recordTimeIso(record) ?? item.endedAt,
            durationMs:
              typeof payload.durationMs === 'number' ? payload.durationMs : item.durationMs,
            error: readTurnErrorMessage(payload.error) ?? item.error,
          };
        })
      : base.items;

  const wireIdByOrdinal = new Map<number, number>();
  if (hasExplicitTurnId) {
    for (const [rawTurnId, ordinal] of ordinalByRawTurnId) {
      wireIdByOrdinal.set(ordinal, rawTurnId);
    }
  }
  const wedgedTurnIds = new Set<number>();
  let latestPromptTurnId: number | undefined;
  if (hasExplicitTurnId) {
    for (const rawTurnId of turnOrigins.keys()) {
      if (latestPromptTurnId === undefined || rawTurnId > latestPromptTurnId) {
        latestPromptTurnId = rawTurnId;
      }
    }
    for (const rawTurnId of turnOrigins.keys()) {
      if (endedTurns.has(rawTurnId) || activeCancelTurnIds.has(rawTurnId)) continue;
      if (rawTurnId === latestPromptTurnId && options?.activeWireTurnId === rawTurnId) continue;
      wedgedTurnIds.add(rawTurnId);
    }
  }
  const missingTurnIds = rawTurnIds.filter(
    (rawTurnId) =>
      !ordinalByRawTurnId.has(rawTurnId) &&
      turnOrigins.has(rawTurnId) &&
      (endedTurns.has(rawTurnId) ||
        interruptedSteps.has(rawTurnId) ||
        (wedgedTurnIds.has(rawTurnId) &&
          rawTurnId !== latestPromptTurnId &&
          materializedTurnIds.has(rawTurnId)) ||
        options?.activeWireTurnId === rawTurnId),
  );
  if (!hasExplicitTurnId && missingTurnIds.length > 0) {
    for (const [rawTurnId, ordinal] of ordinalByRawTurnId) {
      wireIdByOrdinal.set(ordinal, rawTurnId);
    }
  }
  const realignedBaseItems =
    wireIdByOrdinal.size === 0
      ? items
      : (() => {
          const claimedOrdinals = new Set<number>();
          for (const item of items) {
            if (item.kind !== 'turn') continue;
            const wireId = wireIdByOrdinal.get(item.ordinal);
            if (wireId === undefined || wireId === item.ordinal) claimedOrdinals.add(item.ordinal);
          }
          return items.map((item) => {
            if (item.kind !== 'turn') return item;
            const wireId = wireIdByOrdinal.get(item.ordinal);
            if (wireId === undefined) return item;
            let ordinal = item.ordinal;
            if (wireId !== item.ordinal) {
              if (!claimedOrdinals.has(wireId)) {
                ordinal = wireId;
              } else {
                while (claimedOrdinals.has(ordinal)) ordinal += 1;
              }
              claimedOrdinals.add(ordinal);
            }
            const renumber = ordinal !== item.ordinal;
            const nextTurnId = renumber ? exportTurnKey(ordinal) : item.turnId;
            const wedged = wedgedTurnIds.has(wireId);
            return {
              ...item,
              turnId: nextTurnId,
              ordinal,
              startedAt: item.startedAt ?? turnStartedTimes.get(wireId) ?? turnPromptTimes.get(wireId),
              state: wedged ? 'failed' : item.state,
              wedged: wedged ? true : item.wedged,
              steps: renumber
                ? item.steps.map((step) => renameTurnStep(step, item.turnId, nextTurnId))
                : item.steps,
            };
          });
        })();
  const realignedItems: TranscriptItem[] =
    missingTurnIds.length === 0 ? (realignedBaseItems as TranscriptItem[]) : [...realignedBaseItems];
  const occupiedOrdinals = new Set(
    realignedItems.flatMap((item) => item.kind === 'turn' ? [item.ordinal] : []),
  );
  const occupiedTurnIds = new Set(
    realignedItems.flatMap((item) => item.kind === 'turn' ? [item.turnId] : []),
  );
  for (const rawTurnId of missingTurnIds) {
    let ordinal = rawTurnId;
    while (occupiedOrdinals.has(ordinal) || occupiedTurnIds.has(exportTurnKey(ordinal))) {
      ordinal += 1;
    }
    const nextTurnId = exportTurnKey(ordinal);
    occupiedOrdinals.add(ordinal);
    occupiedTurnIds.add(nextTurnId);
    const ended = endedTurns.get(rawTurnId) as TurnEndedPayload | undefined;
    const wedged = wedgedTurnIds.has(rawTurnId);
    const turn: TranscriptTurn = {
      kind: 'turn',
      turnId: nextTurnId,
      ordinal,
      state: mapTurnEndReason(ended?.reason) ?? (wedged ? 'failed' : 'running'),
      origin: { kind: turnOriginKind(turnOrigins.get(rawTurnId)) } as TranscriptTurn['origin'],
      triggerPromptId: turnPromptIds.get(rawTurnId),
      steps: [],
      startedAt: turnStartedTimes.get(rawTurnId) ?? turnPromptTimes.get(rawTurnId),
      endedAt: ended === undefined ? undefined : recordTimeIso(ended as HistoryWireRecord),
      durationMs: typeof ended?.durationMs === 'number' ? ended.durationMs : undefined,
      error: readTurnErrorMessage(ended?.error),
      wedged: wedged ? true : undefined,
    };
    const insertAt = realignedItems.findIndex(
      (item) => item.kind === 'turn' && item.ordinal > ordinal,
    );
    realignedItems.splice(insertAt === -1 ? realignedItems.length : insertAt, 0, turn);
  }

  let restoredItems = appended.length > 0 ? [...realignedItems, ...appended] : realignedItems;
  if (subagentRefs.size > 0) {
    restoredItems = restoredItems.map((item) => {
      if (item.kind !== 'turn') return item;
      return {
        ...item,
        steps: item.steps.map((step) => ({
          ...step,
          frames: step.frames.map((frame) => {
            if (frame.kind !== 'tool') return frame;
            const refs = subagentRefs.get(frame.toolCallId);
            if (refs === undefined) return frame;
            return {
              ...frame,
              agentRefs: [...refs.values()]
                .toSorted((a, b) => (a.index ?? 0) - (b.index ?? 0))
                .map(({ ref }) => ref),
            };
          }),
        })),
      };
    });
  }

  return {
    ...base,
    items: restoredItems,
    interactions: [...interactions.values()],
  };
}

function renameTurnStep(step: TranscriptStep, fromTurnId: string, toTurnId: string): TranscriptStep {
  const stepId = step.stepId.startsWith(`${fromTurnId}.`)
    ? `${toTurnId}.${step.stepId.slice(fromTurnId.length + 1)}`
    : step.stepId;
  return {
    ...step,
    stepId,
    turnId: toTurnId,
    frames: step.frames.map((frame) => ({
      ...frame,
      frameId: frame.frameId.startsWith(`${step.stepId}.`)
        ? `${stepId}.${frame.frameId.slice(step.stepId.length + 1)}`
        : frame.frameId,
    })),
  };
}
