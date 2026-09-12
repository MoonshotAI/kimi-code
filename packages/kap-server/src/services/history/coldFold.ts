import {
  daemonFileRefFromPart,
  parseDaemonFileUrl,
  type ContentPart,
  type TokenUsage,
} from '@moonshot-ai/agent-core-v2';

import type {
  ContentPart as WireContentPart,
  HistoryMessage,
  InteractionMessage,
  StepTiming,
  StepUsage,
  SystemMessage,
  TaskMessage,
  TaskNotificationPayload,
  TurnOrigin,
  UserMessageOrigin,
} from '../../protocol/messages';
import {
  mapInteractionEndStatus,
  notificationTextOf,
  parseToolArgs,
  promptTextOf,
  skillActivationsOf,
  taskNotificationOriginOf,
  taskUserOriginOf,
  textPartsOf,
  todoWriteItems,
  toTurnOrigin,
  userOriginOf,
  wantsUserMessage,
  wireContentParts,
  wireInteractionRequest,
  wireInteractionResponse,
} from '../projection/agentProjector';
import type { ContextRecord } from '../projection/heal';
import {
  SystemIdAllocator,
  TODO_ENTITY_ID,
  attachmentIdOf,
  isUndoAnchorOrigin,
  isVisibleTurnOrigin,
  stepIdOf,
  textMessageIdOf,
  turnIdOf,
  turnOrdinalOf,
  turnUserMessageIdOf,
  type DurableSystemSubtype,
} from '../projection/ids';

export interface ColdFoldOptions {
  readonly sessionId: string;
  readonly agentId: string;
  readonly live: boolean;
  readonly fallbackTimestamp: number;
  readonly subagentTaskIds?: ReadonlyMap<string, string>;
  readonly resolvePlanRevisionKey?: (key: string) => string;
}

interface TurnDraft {
  readonly turnId: string;
  readonly rawId: number;
  readonly origin: TurnOrigin;
  status: 'running' | 'completed';
  userMessageId?: string;
  attachmentIds?: string[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  at: number;
}

interface StepDraft {
  readonly stepId: string;
  readonly turnId: string;
  readonly ordinal: number;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  startedAt?: string;
  endedAt?: string;
  usage?: StepUsage;
  finishReason?: string;
  timing?: StepTiming;
  retry?: {
    failed_attempt: number;
    next_attempt: number;
    max_attempts: number;
    delay_ms: number;
    error_name: string;
    error_message: string;
    status_code?: number;
  };
  endReason?: string;
  endMessage?: string;
  at: number;
}

interface TextDraft {
  readonly messageId: string;
  readonly kind: 'assistant' | 'thinking';
  readonly turnId: string;
  readonly stepId: string;
  text: string;
  at: number;
}

interface ToolDraft {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly stepId: string;
  name: string;
  status: 'running' | 'done' | 'error';
  input?: unknown;
  inputText?: string;
  output?: unknown;
  error?: string;
  taskId?: string;
  approvalId?: string;
  todoId?: string;
  agentRefs: { agent_id: string; role?: 'child' | 'member' }[];
  at: number;
}

interface UserDraft {
  readonly messageId: string;
  readonly turnId?: string;
  readonly text: WireContentPart[];
  readonly timestamp?: number;
  origin?: UserMessageOrigin;
  attachmentIds?: string[];
  skillActivations?: { skill_name: string; skill_args?: string }[];
}

interface SystemDraft {
  readonly systemId: string;
  readonly subtype: SystemMessage['subtype'];
  readonly payload: unknown;
  readonly at?: string;
  readonly atMs: number;
}

interface InteractionDraft {
  readonly interactionId: string;
  readonly kind: 'approval' | 'question';
  status: InteractionMessage['status'];
  toolCallId?: string;
  request?: unknown;
  response?: unknown;
  at: number;
}

interface TaskDraft {
  readonly taskId: string;
  readonly kind: TaskMessage['kind'];
  status: TaskMessage['status'];
  detached: boolean;
  description?: string;
  childAgentId?: string;
  outputTail: string;
  startedAt?: string;
  endedAt?: string;
  resultSummary?: string;
  error?: string;
  stateReason?: string;
  usage?: StepUsage;
  model?: string;
  thinkingEffort?: string;
  at: number;
}

interface SteerInput {
  readonly input: readonly ContentPart[];
  readonly origin: UserMessageOrigin | undefined;
  readonly skillActivations: { skill_name: string; skill_args?: string }[] | undefined;
  readonly skipBlocks: number;
  readonly at: number;
  readonly messageId?: string;
  readonly text?: string;
}

interface TurnScratch {
  currentStep?: number;
  serverUserSeq: number;
  attachmentSeq: number;
  openingInputKey?: string;
  openingSteerDeduped: boolean;
}

interface GoalState {
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  completionCriterion?: string;
  budgetUsed?: number;
  budgetLimit?: number;
}

const TASK_STATUSES = new Set<TaskMessage['status']>([
  'running',
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);

const GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'complete']);

export function foldWireHistory(
  records: readonly ContextRecord[],
  options: ColdFoldOptions,
): HistoryMessage[] {
  const turns = new Map<string, TurnDraft>();
  const steps = new Map<string, StepDraft>();
  const texts = new Map<string, TextDraft>();
  const stepTextIds = new Map<string, { assistant?: string; thinking?: string }>();
  const stepTextSeqs = new Map<string, number>();
  const tools = new Map<string, ToolDraft>();
  const users = new Map<string, UserDraft>();
  const systems = new Map<string, SystemDraft>();
  const interactions = new Map<string, InteractionDraft>();
  const tasks = new Map<string, TaskDraft>();
  const order: string[] = [];
  const timelineIds: string[] = [];
  const sysIds = new SystemIdAllocator();

  const stepRefs = new Map<string, { turn: number; step: number }>();
  const scratchByTurn = new Map<number, TurnScratch>();
  let currentTurn: number | undefined;

  let nextTurnId = 0;
  let phantomUserSeq = 0;
  const cancelledTurnIds = new Set<number>();
  const hiddenTurnIds = new Set<number>();
  const turnPromptIds = new Map<number, string>();
  const pendingAnchorTurnIds: number[] = [];
  const undoAnchors: { rawId: number }[] = [];
  let undoAnchorFloor = 0;
  const activeCancelTurnIds = new Set<number>();

  const queuedPrompts = new Map<string, { content: readonly ContentPart[]; at: number; steered?: boolean }>();
  const mergedSteers: { text: string; promptIds: string[] }[] = [];

  const subagentTaskIds = new Map(options.subagentTaskIds ?? []);
  const agentTaskLinks: { taskId: string; agentId: string; parentToolCallId?: string }[] = [];
  for (const record of records) {
    if (record.type !== 'task.started' && record.type !== 'task.terminated') continue;
    const info = record['info'] as { kind?: unknown; agentId?: unknown; taskId?: unknown; parentToolCallId?: unknown } | undefined;
    if (info?.kind !== 'agent') continue;
    if (typeof info.agentId !== 'string' || typeof info.taskId !== 'string') continue;
    subagentTaskIds.set(info.agentId, info.taskId);
    agentTaskLinks.push({
      taskId: info.taskId,
      agentId: info.agentId,
      parentToolCallId: typeof info.parentToolCallId === 'string' ? info.parentToolCallId : undefined,
    });
  }

  let goal: GoalState | undefined;
  let lastAtMs = options.fallbackTimestamp;

  const atMs = (record: ContextRecord): number => {
    const time = record.time;
    if (typeof time === 'number' && Number.isFinite(time)) {
      lastAtMs = time;
    }
    return lastAtMs;
  };

  const atIso = (record: ContextRecord): string => new Date(atMs(record)).toISOString();

  const scratch = (rawId: number): TurnScratch => {
    let entry = scratchByTurn.get(rawId);
    if (entry === undefined) {
      entry = { serverUserSeq: 0, attachmentSeq: 0, openingSteerDeduped: false };
      scratchByTurn.set(rawId, entry);
    }
    return entry;
  };

  const pushSystem = (
    subtype: DurableSystemSubtype,
    payload: unknown,
    record: ContextRecord,
  ): void => {
    const systemId = sysIds.next(subtype);
    systems.set(systemId, { systemId, subtype, payload, at: atIso(record), atMs: atMs(record) });
    order.push(`sys:${systemId}`);
    timelineIds.push(systemId);
  };

  const skipCancelledTurnIds = (): void => {
    while (cancelledTurnIds.delete(nextTurnId)) {
      hiddenTurnIds.add(nextTurnId);
      nextTurnId += 1;
    }
  };

  const createTextDraft = (
    stepId: string,
    turnId: string,
    kind: 'assistant' | 'thinking',
    recordAtMs: number,
  ): TextDraft => {
    const seq = (stepTextSeqs.get(stepId) ?? 0) + 1;
    stepTextSeqs.set(stepId, seq);
    const draft: TextDraft = {
      messageId: textMessageIdOf(stepId, seq),
      kind,
      turnId,
      stepId,
      text: '',
      at: recordAtMs,
    };
    texts.set(draft.messageId, draft);
    const entry = stepTextIds.get(stepId) ?? {};
    entry[kind] = draft.messageId;
    stepTextIds.set(stepId, entry);
    order.push(`text:${draft.messageId}`);
    return draft;
  };

  const ensureStepDraft = (
    rawId: number,
    stepOrdinal: number,
    recordAtMs: number,
  ): StepDraft | undefined => {
    if (hiddenTurnIds.has(rawId)) return undefined;
    const turnId = turnIdOf(rawId);
    if (!turns.has(turnId)) return undefined;
    const stepId = stepIdOf(turnId, stepOrdinal);
    const existing = steps.get(stepId);
    if (existing !== undefined) return existing;
    const draft: StepDraft = {
      stepId,
      turnId,
      ordinal: stepOrdinal,
      status: 'running',
      startedAt: new Date(recordAtMs).toISOString(),
      at: recordAtMs,
    };
    steps.set(stepId, draft);
    order.push(`step:${stepId}`);
    return draft;
  };

  const emitSteer = (rawId: number, steer: SteerInput): void => {
    const turnId = turnIdOf(rawId);
    const entry = scratch(rawId);
    let messageId = steer.messageId;
    if (messageId === undefined) {
      entry.serverUserSeq += 1;
      messageId = `${turnId}.u${entry.serverUserSeq}`;
    }
    const attachmentIds: string[] = [];
    for (const part of steer.input.slice(steer.skipBlocks)) {
      if (part.type === 'text') continue;
      if (daemonFileRefFromPart(part) === undefined) continue;
      entry.attachmentSeq += 1;
      attachmentIds.push(attachmentIdOf(turnId, entry.attachmentSeq));
    }
    const draft: UserDraft = {
      messageId,
      turnId,
      text:
        steer.text !== undefined
          ? textPartsOf(steer.text)
          : wireContentParts(steer.input.slice(steer.skipBlocks)),
      timestamp: steer.at,
      origin: steer.origin,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      skillActivations: steer.skillActivations,
    };
    users.set(messageId, draft);
    order.push(`user:${messageId}`);
  };

  const dropTurnDetails = (turnId: string): void => {
    turns.delete(turnId);
    for (const [stepId, step] of steps) {
      if (step.turnId !== turnId) continue;
      steps.delete(stepId);
      const entry = stepTextIds.get(stepId);
      if (entry?.assistant !== undefined) texts.delete(entry.assistant);
      if (entry?.thinking !== undefined) texts.delete(entry.thinking);
      stepTextIds.delete(stepId);
      stepTextSeqs.delete(stepId);
    }
    for (const [toolCallId, tool] of tools) {
      if (tool.turnId === turnId) tools.delete(toolCallId);
    }
    for (const [messageId, user] of users) {
      if (user.turnId === turnId) users.delete(messageId);
    }
  };

  const removedKeys = new Set<string>();
  const truncateTimeline = (cutIndex: number): string[] => {
    const removed = timelineIds.slice(cutIndex);
    for (const id of removed) {
      if (turnOrdinalOf(id) !== undefined) {
        dropTurnDetails(id);
      } else {
        systems.delete(id);
      }
    }
    timelineIds.length = cutIndex;
    return removed;
  };

  const pruneOrder = (): void => {
    const kept = order.filter((key) => !removedKeys.has(key));
    order.length = 0;
    order.push(...kept);
    removedKeys.clear();
  };

  const markRemoved = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (turnOrdinalOf(id) !== undefined) {
        removedKeys.add(`turn:${id}`);
        for (const [stepId, step] of steps) {
          if (step.turnId === id) removedKeys.add(`step:${stepId}`);
        }
        for (const messageId of texts.keys()) {
          if (texts.get(messageId)?.turnId === id) removedKeys.add(`text:${messageId}`);
        }
        for (const [toolCallId, tool] of tools) {
          if (tool.turnId === id) removedKeys.add(`tool:${toolCallId}`);
        }
        for (const [messageId, user] of users) {
          if (user.turnId === id) removedKeys.add(`user:${messageId}`);
        }
      } else {
        removedKeys.add(`sys:${id}`);
      }
    }
  };

  const onTurnPrompt = (record: ContextRecord): void => {
    skipCancelledTurnIds();
    const recordTurnId = record['turnId'];
    const rawId =
      typeof recordTurnId === 'number' && Number.isInteger(recordTurnId) && recordTurnId >= 0
        ? recordTurnId
        : nextTurnId;
    nextTurnId = Math.max(nextTurnId, rawId + 1);
    const carriedUserSeq = phantomUserSeq;
    phantomUserSeq = 0;
    const origin = record['origin'];
    const promptId = record['promptId'];
    if (typeof promptId === 'string') {
      turnPromptIds.set(rawId, promptId);
      queuedPrompts.delete(promptId);
    } else {
      const rawInput = record['input'];
      const inputKey = JSON.stringify(Array.isArray(rawInput) ? rawInput : []);
      for (const [queuedId, queued] of queuedPrompts) {
        if (JSON.stringify(queued.content) === inputKey) {
          queuedPrompts.delete(queuedId);
          break;
        }
      }
    }
    if (isUndoAnchorOrigin(origin)) pendingAnchorTurnIds.push(rawId);
    currentTurn = rawId;
    if (!isVisibleTurnOrigin(origin)) {
      hiddenTurnIds.add(rawId);
      return;
    }
    const recordAtMs = atMs(record);
    const recordAtIso = new Date(recordAtMs).toISOString();
    const turnId = turnIdOf(rawId);
    const input = Array.isArray(record['input']) ? (record['input'] as ContentPart[]) : [];
    const skipBlocks = bundledSkillCount(origin);
    const promptText = turnPromptText(input, skipBlocks);
    const attachments = promptAttachmentCount(input, origin);
    const attachmentIds =
      attachments > 0
        ? Array.from({ length: attachments }, (_, i) => attachmentIdOf(turnId, i + 1))
        : undefined;
    const wantsUser = wantsUserMessage(origin, promptText);
    const taskOrigin = taskNotificationOriginOf(origin);
    const openingMessageId =
      wantsUser || taskOrigin !== undefined
        ? ((typeof promptId === 'string' ? promptId : undefined) ?? turnUserMessageIdOf(turnId))
        : undefined;
    const draft: TurnDraft = {
      turnId,
      rawId,
      origin: toTurnOrigin(origin, options.agentId, subagentTaskIds),
      status: 'running',
      userMessageId: openingMessageId,
      attachmentIds,
      startedAt: recordAtIso,
      at: recordAtMs,
    };
    turns.set(turnId, draft);
    order.push(`turn:${turnId}`);
    timelineIds.push(turnId);
    scratchByTurn.set(rawId, {
      serverUserSeq: carriedUserSeq,
      attachmentSeq: attachments,
      openingInputKey: JSON.stringify(input),
      openingSteerDeduped: false,
    });
    if (openingMessageId !== undefined) {
      const notification =
        taskOrigin === undefined ? undefined : parseNotificationXmlText(promptText ?? '');
      const user: UserDraft = {
        messageId: openingMessageId,
        turnId,
        text:
          notification !== undefined
            ? textPartsOf(notificationTextOf(notification))
            : wireContentParts(input.slice(skipBlocks)),
        timestamp: recordAtMs,
        origin:
          notification !== undefined
            ? taskUserOriginOf(taskOrigin?.task_id, notification)
            : (taskOrigin ?? userOriginOf(origin)),
        attachmentIds,
        skillActivations: skillActivationsOf(origin),
      };
      users.set(user.messageId, user);
      order.push(`user:${user.messageId}`);
    }
  };

  const onTurnSteer = (record: ContextRecord): void => {
    const origin = record['origin'] as
      | { kind?: string; skillActivations?: readonly { skillName: string; skillArgs?: string }[]; trigger?: string }
      | undefined;
    const kind = origin?.kind;
    if (kind !== 'user' && kind !== 'skill_activation' && kind !== 'cron_job') return;
    if (kind === 'skill_activation' && origin?.trigger !== 'user-slash') return;
    const rawId = currentTurn;
    if (rawId === undefined || hiddenTurnIds.has(rawId)) return;
    const input = Array.isArray(record['input']) ? (record['input'] as ContentPart[]) : [];
    const skipBlocks = kind === 'user' ? (origin?.skillActivations?.length ?? 0) : 0;
    const entry = scratch(rawId);
    if (
      entry.currentStep === undefined &&
      !entry.openingSteerDeduped &&
      entry.openingInputKey !== undefined &&
      entry.openingInputKey === JSON.stringify(input)
    ) {
      entry.openingSteerDeduped = true;
      return;
    }
    if (kind === 'user') {
      const recordAtMs = atMs(record);
      const matchedId = matchQueuedPrompt(input, skipBlocks);
      if (matchedId !== undefined) {
        purgeMergedSteer(promptTextOf(input.slice(skipBlocks)));
        emitSteer(rawId, {
          input,
          origin: userOriginOf(origin),
          skillActivations: skillActivationsOf(origin),
          skipBlocks,
          at: recordAtMs,
          messageId: matchedId,
        });
        return;
      }
      const mergedUsers = matchMergedSteer(input, skipBlocks);
      if (mergedUsers !== undefined) {
        for (const { messageId, content } of mergedUsers) {
          const draft: UserDraft = {
            messageId,
            turnId: turnIdOf(rawId),
            text: wireContentParts(content),
            timestamp: recordAtMs,
          };
          users.set(messageId, draft);
          order.push(`user:${messageId}`);
        }
        return;
      }
    }
    emitSteer(rawId, {
      input,
      origin: userOriginOf(origin),
      skillActivations: skillActivationsOf(origin),
      skipBlocks,
      at: atMs(record),
    });
  };

  const matchQueuedPrompt = (input: readonly ContentPart[], skipBlocks: number): string | undefined => {
    const text = promptTextOf(input.slice(skipBlocks));
    let matched: string | undefined;
    for (const [queuedId, queued] of queuedPrompts) {
      if (promptTextOf(queued.content) !== text) continue;
      if (matched !== undefined) return undefined;
      matched = queuedId;
    }
    if (matched !== undefined) queuedPrompts.delete(matched);
    return matched;
  };

  const matchMergedSteer = (
    input: readonly ContentPart[],
    skipBlocks: number,
  ): { messageId: string; content: readonly ContentPart[] }[] | undefined => {
    const text = promptTextOf(input.slice(skipBlocks));
    const index = mergedSteers.findIndex((entry) => entry.text === text);
    if (index < 0) return undefined;
    const [entry] = mergedSteers.splice(index, 1);
    if (entry === undefined) return undefined;
    const matched: { messageId: string; content: readonly ContentPart[] }[] = [];
    for (const promptId of entry.promptIds) {
      const queued = queuedPrompts.get(promptId);
      if (queued !== undefined) matched.push({ messageId: promptId, content: queued.content });
      queuedPrompts.delete(promptId);
    }
    return matched;
  };

  const purgeMergedSteer = (text: string): void => {
    for (let i = mergedSteers.length - 1; i >= 0; i--) {
      if (mergedSteers[i]!.text === text) mergedSteers.splice(i, 1);
    }
  };

  const onLoopEvent = (record: ContextRecord): void => {
    const event = record['event'] as { type?: string } | undefined;
    if (event?.type === undefined) return;
    switch (event.type) {
      case 'step.begin': {
        const e = event as { uuid: string; turnId?: string; step?: number };
        if (e.turnId === undefined || e.step === undefined) return;
        const turn = Number(e.turnId);
        if (!Number.isInteger(turn)) return;
        stepRefs.set(e.uuid, { turn, step: e.step });
        const draft = ensureStepDraft(turn, e.step, atMs(record));
        if (draft === undefined) return;
        draft.startedAt = draft.startedAt ?? atIso(record);
        const entry = scratch(turn);
        entry.currentStep = e.step;
        currentTurn = turn;
        return;
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
        const ref = stepRefs.get(e.uuid);
        if (ref === undefined) return;
        const draft = steps.get(stepIdOf(turnIdOf(ref.turn), ref.step));
        if (draft === undefined) return;
        draft.status = 'completed';
        draft.endedAt = atIso(record);
        draft.usage = e.usage === undefined ? undefined : toSnakeUsage(e.usage);
        draft.finishReason = e.finishReason ?? e.rawFinishReason ?? e.providerFinishReason;
        draft.timing =
          e.llmFirstTokenLatencyMs === undefined && e.llmStreamDurationMs === undefined
            ? undefined
            : {
                llm_first_token_ms: e.llmFirstTokenLatencyMs,
                llm_stream_duration_ms: e.llmStreamDurationMs,
              };
        draft.retry = undefined;
        draft.at = atMs(record);
        return;
      }
      case 'content.part': {
        const e = event as {
          stepUuid: string;
          part: { type: string; text?: string; think?: string };
          turnId?: string;
          step?: number;
        };
        const ref = resolveStepRef(stepRefs, e.stepUuid, e.turnId, e.step);
        if (ref === undefined) return;
        const draft = ensureStepDraft(ref.turn, ref.step, atMs(record));
        if (draft === undefined) return;
        const kind = e.part.type === 'text' ? 'assistant' : e.part.type === 'think' ? 'thinking' : undefined;
        const partText = e.part.type === 'think' ? e.part.think : e.part.text;
        if (kind === undefined || typeof partText !== 'string') return;
        if (kind === 'thinking' && partText.length === 0) return;
        const stepId = draft.stepId;
        const existingId = stepTextIds.get(stepId)?.[kind];
        const text = existingId === undefined ? undefined : texts.get(existingId);
        const target = text ?? createTextDraft(stepId, draft.turnId, kind, atMs(record));
        target.text += partText;
        target.at = atMs(record);
        return;
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
        const ref = resolveStepRef(stepRefs, e.stepUuid, e.turnId, e.step);
        if (ref === undefined) return;
        const draft = ensureStepDraft(ref.turn, ref.step, atMs(record));
        if (draft === undefined) return;
        const existing = tools.get(e.toolCallId);
        const input = parseToolArgs(e.args);
        const tool: ToolDraft = {
          toolCallId: e.toolCallId,
          turnId: draft.turnId,
          stepId: draft.stepId,
          name: e.name,
          status: existing?.status ?? 'running',
          input,
          inputText: typeof e.args === 'string' ? e.args : undefined,
          output: existing?.output,
          error: existing?.error,
          taskId: existing?.taskId ?? taskIdByToolCall(e.toolCallId),
          approvalId: existing?.approvalId,
          todoId:
            existing?.todoId ??
            (e.name === 'TodoList' && todoWriteItems(input) !== undefined
              ? TODO_ENTITY_ID
              : undefined),
          agentRefs: existing?.agentRefs ?? agentRefsOf(e.toolCallId),
          at: atMs(record),
        };
        tools.set(e.toolCallId, tool);
        if (existing === undefined) order.push(`tool:${e.toolCallId}`);
        return;
      }
      case 'tool.result': {
        const e = event as {
          toolCallId: string;
          result: { output: unknown; isError?: boolean };
        };
        const existing = tools.get(e.toolCallId);
        if (existing === undefined) return;
        const isError = e.result.isError === true;
        existing.status = isError ? 'error' : 'done';
        existing.output = e.result.output;
        existing.error = isError && typeof e.result.output === 'string' ? e.result.output : undefined;
        existing.at = atMs(record);
        return;
      }
      default:
        return;
    }
  };

  const taskIdByToolCall = (toolCallId: string): string | undefined => {
    for (const link of agentTaskLinks) {
      if (link.parentToolCallId === toolCallId) return link.taskId;
    }
    return undefined;
  };

  const agentRefsOf = (toolCallId: string): { agent_id: string; role?: 'child' | 'member' }[] => {
    const refs: { agent_id: string; role?: 'child' | 'member' }[] = [];
    for (const link of agentTaskLinks) {
      if (link.parentToolCallId === toolCallId) refs.push({ agent_id: link.agentId, role: 'child' });
    }
    return refs;
  };

  const onTaskNotificationAppend = (
    message: { content?: ContentPart[] },
    taskOrigin: Extract<UserMessageOrigin, { kind: 'task' }>,
    record: ContextRecord,
  ): void => {
    const recordAtMs = atMs(record);
    const input = Array.isArray(message.content) ? message.content : [];
    const rawText = promptTextOf(input);
    const notification = parseNotificationXmlText(rawText);
    const origin =
      notification === undefined ? taskOrigin : taskUserOriginOf(taskOrigin.task_id, notification);
    if (origin === undefined) return;
    const rawId = currentTurn;
    if (rawId !== undefined && !hiddenTurnIds.has(rawId)) {
      const turnId = turnIdOf(rawId);
      const turn = turns.get(turnId);
      const entry = scratchByTurn.get(rawId);
      if (
        turn !== undefined &&
        turn.origin.kind === 'task' &&
        turn.origin.task_id === taskOrigin.task_id &&
        entry?.currentStep === undefined
      ) {
        return;
      }
      if (turn !== undefined && turn.status === 'running') {
        emitSteer(rawId, {
          input,
          origin,
          skillActivations: undefined,
          skipBlocks: 0,
          at: recordAtMs,
          text: notification === undefined ? rawText : notificationTextOf(notification),
        });
        return;
      }
    }
    phantomUserSeq += 1;
    const turnId = turnIdOf(nextTurnId);
    const draft: UserDraft = {
      messageId: `${turnId}.u${phantomUserSeq}`,
      turnId,
      text: textPartsOf(notification === undefined ? rawText : notificationTextOf(notification)),
      timestamp: recordAtMs,
      origin,
    };
    users.set(draft.messageId, draft);
    order.push(`user:${draft.messageId}`);
  };

  const onAppendMessage = (record: ContextRecord): void => {
    const message = record['message'] as
      | {
          id?: string;
          role?: string;
          content?: ContentPart[];
          toolCalls?: readonly { id: string; name: string; arguments: string | null }[];
          toolCallId?: string;
          isError?: boolean;
          origin?: unknown;
        }
      | undefined;
    if (message?.role === undefined) return;
    if (message.role === 'user') {
      const taskOrigin = taskNotificationOriginOf(message.origin);
      if (taskOrigin !== undefined) {
        onTaskNotificationAppend(message, taskOrigin, record);
        return;
      }
      if (!isUndoAnchorOrigin(message.origin)) return;
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
      return;
    }
    if (message.role === 'assistant') {
      const recordAtMs = atMs(record);
      const recordAtIso = new Date(recordAtMs).toISOString();
      let rawId = currentTurn;
      if (rawId === undefined || hiddenTurnIds.has(rawId) || !turns.has(turnIdOf(rawId))) {
        rawId = nextTurnId;
        nextTurnId += 1;
        const turnId = turnIdOf(rawId);
        const draft: TurnDraft = {
          turnId,
          rawId,
          origin: { kind: 'other' },
          status: 'running',
          startedAt: recordAtIso,
          at: recordAtMs,
        };
        turns.set(turnId, draft);
        order.push(`turn:${turnId}`);
        timelineIds.push(turnId);
        currentTurn = rawId;
        scratchByTurn.set(rawId, {
          serverUserSeq: 0,
          attachmentSeq: 0,
          openingSteerDeduped: false,
        });
      }
      const entry = scratch(rawId);
      const ordinal = (entry.currentStep ?? 0) + 1;
      const step = ensureStepDraft(rawId, ordinal, recordAtMs);
      if (step === undefined) return;
      entry.currentStep = ordinal;
      step.status = 'completed';
      step.endedAt = recordAtIso;
      step.at = recordAtMs;
      for (const part of message.content ?? []) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          const existingId = stepTextIds.get(step.stepId)?.assistant;
          const target =
            (existingId === undefined ? undefined : texts.get(existingId)) ??
            createTextDraft(step.stepId, step.turnId, 'assistant', recordAtMs);
          target.text += part.text;
          target.at = recordAtMs;
        } else if (part.type === 'think') {
          const think = (part as { think?: unknown }).think;
          if (typeof think !== 'string' || think.length === 0) continue;
          const existingId = stepTextIds.get(step.stepId)?.thinking;
          const target =
            (existingId === undefined ? undefined : texts.get(existingId)) ??
            createTextDraft(step.stepId, step.turnId, 'thinking', recordAtMs);
          target.text += think;
          target.at = recordAtMs;
        }
      }
      for (const call of message.toolCalls ?? []) {
        if (tools.has(call.id)) continue;
        const input = parseToolArgs(call.arguments ?? undefined);
        const tool: ToolDraft = {
          toolCallId: call.id,
          turnId: step.turnId,
          stepId: step.stepId,
          name: call.name,
          status: 'running',
          input,
          inputText: typeof call.arguments === 'string' ? call.arguments : undefined,
          taskId: taskIdByToolCall(call.id),
          todoId:
            call.name === 'TodoList' && todoWriteItems(input) !== undefined
              ? TODO_ENTITY_ID
              : undefined,
          agentRefs: agentRefsOf(call.id),
          at: recordAtMs,
        };
        tools.set(call.id, tool);
        order.push(`tool:${call.id}`);
      }
      return;
    }
    if (message.role === 'tool') {
      const toolCallId = message.toolCallId;
      if (typeof toolCallId !== 'string') return;
      const existing = tools.get(toolCallId);
      if (existing === undefined) return;
      const output = promptTextOf(message.content ?? []);
      const isError = message.isError === true;
      existing.status = isError ? 'error' : 'done';
      existing.output = output;
      existing.error = isError ? output : undefined;
      existing.at = atMs(record);
      return;
    }
  };

  const onTurnEnded = (record: ContextRecord): void => {
    const rawId = record['turnId'];
    if (typeof rawId !== 'number' || !Number.isInteger(rawId)) return;
    const pendingIndex = pendingAnchorTurnIds.indexOf(rawId);
    if (pendingIndex >= 0) pendingAnchorTurnIds.splice(pendingIndex, 1);
    const draft = turns.get(turnIdOf(rawId));
    if (draft === undefined) return;
    const recordAtMs = atMs(record);
    const recordAtIso = new Date(recordAtMs).toISOString();
    const reason = record['reason'];
    const entry = scratch(rawId);
    const step =
      entry.currentStep === undefined
        ? undefined
        : steps.get(stepIdOf(turnIdOf(rawId), entry.currentStep));
    if (step !== undefined && step.status === 'running') {
      step.status = reason === 'failed' || reason === 'blocked' ? 'failed' : 'interrupted';
      step.endedAt = recordAtIso;
      step.at = recordAtMs;
    }
    draft.status = 'completed';
    draft.endedAt = recordAtIso;
    draft.durationMs = typeof record['durationMs'] === 'number' ? record['durationMs'] : undefined;
    draft.at = recordAtMs;
  };

  const onUndo = (record: ContextRecord): void => {
    const count = record['count'];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) return;
    let firstUndone: number | undefined;
    for (let i = 0; i < count && undoAnchors.length > undoAnchorFloor; i++) {
      const anchor = undoAnchors.pop();
      if (anchor !== undefined) firstUndone = anchor.rawId;
    }
    if (firstUndone === undefined) return;
    const cut = timelineIds.findIndex((id) => {
      const ordinal = turnOrdinalOf(id);
      return ordinal !== undefined && ordinal >= firstUndone;
    });
    if (cut < 0) return;
    const removed = timelineIds.slice(cut);
    markRemoved(removed);
    truncateTimeline(cut);
    pruneOrder();
    for (let turnId = firstUndone; turnId < nextTurnId; turnId++) hiddenTurnIds.add(turnId);
    if (currentTurn !== undefined && currentTurn >= firstUndone) currentTurn = undefined;
    pushSystem('undo', { removed_ids: removed }, record);
  };

  const onClear = (record: ContextRecord): void => {
    const removed = [...timelineIds];
    markRemoved(removed);
    for (const id of removed) {
      if (turnOrdinalOf(id) !== undefined) dropTurnDetails(id);
    }
    systems.clear();
    timelineIds.length = 0;
    pruneOrder();
    undoAnchorFloor = undoAnchors.length;
    currentTurn = undefined;
    scratchByTurn.clear();
    pushSystem('clear', { removed_ids: removed }, record);
  };

  const onInteractionRequest = (record: ContextRecord): void => {
    const kind = record['kind'];
    if (kind !== 'approval' && kind !== 'question') return;
    const id = record['id'];
    if (typeof id !== 'string') return;
    const payload = record['request'];
    const innerToolCallId = (payload as { toolCallId?: unknown } | undefined)?.toolCallId;
    const toolCallId =
      typeof record['toolCallId'] === 'string'
        ? record['toolCallId']
        : typeof innerToolCallId === 'string'
          ? innerToolCallId
          : undefined;
    const recordAtMs = atMs(record);
    const draft: InteractionDraft = {
      interactionId: id,
      kind,
      status: 'pending',
      toolCallId,
      request: wireInteractionRequest(kind, payload),
      at: recordAtMs,
    };
    interactions.set(id, draft);
    order.push(`ix:${id}`);
    if (toolCallId !== undefined) {
      const tool = tools.get(toolCallId);
      if (tool !== undefined && tool.approvalId !== id) {
        tool.approvalId = id;
        tool.at = recordAtMs;
      }
    }
  };

  const onInteractionResolved = (record: ContextRecord): void => {
    const id = record['id'];
    if (typeof id !== 'string') return;
    const draft = interactions.get(id);
    if (draft === undefined) return;
    const response = record['response'];
    draft.status = mapInteractionEndStatus(draft.kind, response);
    draft.response = wireInteractionResponse(draft.kind, draft.request, response);
    draft.at = atMs(record);
  };

  const onTaskRecord = (record: ContextRecord): void => {
    const info = record['info'] as
      | {
          taskId?: unknown;
          kind?: unknown;
          status?: unknown;
          detached?: unknown;
          description?: unknown;
          agentId?: unknown;
          startedAt?: unknown;
          endedAt?: unknown;
          stopReason?: unknown;
          model?: unknown;
          thinkingEffort?: unknown;
        }
      | undefined;
    if (info === undefined || typeof info.taskId !== 'string') return;
    const recordAtMs = atMs(record);
    const taskId = info.taskId;
    const prev = tasks.get(taskId);
    const status = info.status;
    const draft: TaskDraft = {
      taskId,
      kind: mapTaskKind(info.kind),
      status:
        typeof status === 'string' && TASK_STATUSES.has(status as TaskMessage['status'])
          ? (status as TaskMessage['status'])
          : (prev?.status ?? 'running'),
      detached: typeof info.detached === 'boolean' ? info.detached : (prev?.detached ?? true),
      description: typeof info.description === 'string' ? info.description : prev?.description,
      childAgentId: typeof info.agentId === 'string' ? info.agentId : prev?.childAgentId,
      outputTail:
        typeof record['outputTail'] === 'string' ? record['outputTail'] : (prev?.outputTail ?? ''),
      startedAt: prev?.startedAt ?? epochMsToIso(info.startedAt),
      endedAt: epochMsToIso(info.endedAt) ?? prev?.endedAt,
      resultSummary: prev?.resultSummary,
      error: prev?.error,
      stateReason: typeof info.stopReason === 'string' ? info.stopReason : prev?.stateReason,
      usage: prev?.usage,
      model: typeof info.model === 'string' ? info.model : prev?.model,
      thinkingEffort:
        typeof info.thinkingEffort === 'string' ? info.thinkingEffort : prev?.thinkingEffort,
      at: recordAtMs,
    };
    tasks.set(taskId, draft);
    if (prev === undefined) order.push(`task:${taskId}`);
  };

  const onGoalRecord = (record: ContextRecord): void => {
    if (record.type === 'goal.create') {
      goal = {
        objective: typeof record['objective'] === 'string' ? record['objective'] : '',
        status: 'active',
        completionCriterion:
          typeof record['completionCriterion'] === 'string'
            ? record['completionCriterion']
            : undefined,
        budgetUsed: 0,
      };
      pushSystem('goal', goalPayloadOf(goal), record);
      return;
    }
    if (record.type === 'goal.update') {
      if (goal !== undefined) {
        const status = record['status'];
        const tokenBudget = (record['budgetLimits'] as { tokenBudget?: unknown } | undefined)
          ?.tokenBudget;
        goal = {
          ...goal,
          status:
            typeof status === 'string' && GOAL_STATUSES.has(status)
              ? (status as GoalState['status'])
              : goal.status,
          budgetUsed:
            typeof record['tokensUsed'] === 'number' ? record['tokensUsed'] : goal.budgetUsed,
          budgetLimit: typeof tokenBudget === 'number' ? tokenBudget : goal.budgetLimit,
        };
      }
      if (
        record['status'] === undefined &&
        record['budgetLimits'] === undefined &&
        record['turnsUsed'] === undefined
      ) {
        return;
      }
      pushSystem('goal', goal === undefined ? undefined : goalPayloadOf(goal), record);
      return;
    }
    goal = undefined;
    pushSystem('goal', undefined, record);
  };

  for (const record of records) {
    switch (record.type) {
      case 'turn.prompt':
        onTurnPrompt(record);
        break;
      case 'turn.steer':
        onTurnSteer(record);
        break;
      case 'context.append_loop_event':
        onLoopEvent(record);
        break;
      case 'context.append_message':
        onAppendMessage(record);
        break;
      case 'turn.ended':
        onTurnEnded(record);
        break;
      case 'turn.step.interrupted': {
        const rawId = record['turnId'];
        const step = record['step'];
        if (typeof rawId !== 'number' || typeof step !== 'number') break;
        if (typeof record['reason'] !== 'string') break;
        const draft = ensureStepDraft(rawId, step, atMs(record));
        if (draft === undefined) break;
        draft.status = 'interrupted';
        draft.endedAt = atIso(record);
        draft.endReason = record['reason'];
        draft.endMessage = typeof record['message'] === 'string' ? record['message'] : undefined;
        draft.at = atMs(record);
        break;
      }
      case 'turn.step.retrying': {
        const rawId = record['turnId'];
        const step = record['step'];
        if (typeof rawId !== 'number' || typeof step !== 'number') break;
        if (
          typeof record['failedAttempt'] !== 'number' ||
          typeof record['nextAttempt'] !== 'number' ||
          typeof record['maxAttempts'] !== 'number' ||
          typeof record['delayMs'] !== 'number' ||
          typeof record['errorName'] !== 'string' ||
          typeof record['errorMessage'] !== 'string'
        ) {
          break;
        }
        const draft = ensureStepDraft(rawId, step, atMs(record));
        if (draft === undefined) break;
        draft.retry = {
          failed_attempt: record['failedAttempt'] as number,
          next_attempt: record['nextAttempt'] as number,
          max_attempts: record['maxAttempts'] as number,
          delay_ms: record['delayMs'] as number,
          error_name: record['errorName'] as string,
          error_message: record['errorMessage'] as string,
          status_code: typeof record['statusCode'] === 'number' ? record['statusCode'] : undefined,
        };
        draft.at = atMs(record);
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
        pushSystem(
          'interruption',
          { turn_id: turnIdOf(turnId), reason: 'user_cancelled' },
          record,
        );
        break;
      }
      case 'context.undo':
        onUndo(record);
        break;
      case 'context.clear':
        onClear(record);
        break;
      case 'context.apply_compaction': {
        undoAnchorFloor = undoAnchors.length;
        const text = compactionSummaryText(record);
        pushSystem(
          'compaction',
          { phase: 'completed', text: text.length > 0 ? text : undefined },
          record,
        );
        break;
      }
      case 'interaction.request':
        onInteractionRequest(record);
        break;
      case 'interaction.resolved':
        onInteractionResolved(record);
        break;
      case 'task.started':
      case 'task.terminated':
        onTaskRecord(record);
        break;
      case 'goal.create':
      case 'goal.update':
      case 'goal.clear':
        onGoalRecord(record);
        break;
      case 'plan_mode.enter':
        pushSystem('plan.enter', undefined, record);
        break;
      case 'plan_mode.exit':
        pushSystem('plan.exit', undefined, record);
        break;
      case 'plan_mode.cancel':
        break;
      case 'plan.revision': {
        const key = record['key'];
        const path =
          typeof key === 'string'
            ? (options.resolvePlanRevisionKey?.(key) ?? key)
            : typeof record['path'] === 'string'
              ? record['path']
              : undefined;
        pushSystem(
          'plan.revision',
          {
            id: record['id'],
            version: record['version'],
            path,
            sha256: record['sha256'],
            bytes: record['bytes'],
          },
          record,
        );
        break;
      }
      case 'swarm_mode.enter':
        pushSystem('swarm.enter', undefined, record);
        break;
      case 'swarm_mode.exit':
        pushSystem('swarm.exit', undefined, record);
        break;
      case 'prompt.accepted': {
        const promptId = record['promptId'];
        const content = record['content'];
        if (typeof promptId !== 'string' || !Array.isArray(content)) break;
        queuedPrompts.set(promptId, { content: content as ContentPart[], at: atMs(record) });
        break;
      }
      case 'prompt.aborted':
      case 'prompt.completed': {
        const promptId = record['promptId'];
        if (typeof promptId === 'string') queuedPrompts.delete(promptId);
        break;
      }
      case 'prompt.steered': {
        const ids = record['promptIds'];
        if (!Array.isArray(ids)) break;
        const content = record['content'];
        const promptIds: string[] = [];
        for (const id of ids) {
          if (typeof id !== 'string') continue;
          promptIds.push(id);
          const queued = queuedPrompts.get(id);
          if (queued !== undefined) queued.steered = true;
        }
        if (Array.isArray(content)) {
          mergedSteers.push({
            text: promptTextOf(content as ContentPart[]),
            promptIds,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  for (const [promptId, { content }] of queuedPrompts) {
    const draft: UserDraft = {
      messageId: promptId,
      text: wireContentParts(content),
    };
    users.set(draft.messageId, draft);
    order.push(`user:${draft.messageId}`);
  }

  const finalTurnStatus = (draft: TurnDraft): 'running' | 'completed' =>
    draft.status === 'running' && options.live ? 'running' : 'completed';

  const finalStepStatus = (draft: StepDraft): StepDraft['status'] =>
    draft.status === 'running' && !options.live ? 'interrupted' : draft.status;

  const turnUsageOf = (turnId: string): StepUsage | undefined => {
    let total: StepUsage | undefined;
    for (const step of steps.values()) {
      if (step.turnId !== turnId || step.usage === undefined) continue;
      total = {
        input_other: (total?.input_other ?? 0) + step.usage.input_other,
        output: (total?.output ?? 0) + step.usage.output,
        input_cache_read: (total?.input_cache_read ?? 0) + step.usage.input_cache_read,
        input_cache_creation:
          (total?.input_cache_creation ?? 0) + step.usage.input_cache_creation,
      };
    }
    return total;
  };

  const synthesizeSubagentTasks = (): void => {
    for (const tool of tools.values()) {
      if (tool.name !== 'Agent' || tool.taskId !== undefined) continue;
      const outputText = typeof tool.output === 'string' ? tool.output : undefined;
      const childAgentId =
        outputText === undefined ? undefined : /^agent_id: (\S+)$/m.exec(outputText)?.[1];
      let realTask: TaskDraft | undefined;
      if (childAgentId !== undefined) {
        for (const task of tasks.values()) {
          if (task.childAgentId === childAgentId) {
            realTask = task;
            break;
          }
        }
      }
      if (childAgentId !== undefined && realTask !== undefined) {
        tool.taskId = realTask.taskId;
        if (!tool.agentRefs.some((ref) => ref.agent_id === childAgentId)) {
          tool.agentRefs = [...tool.agentRefs, { agent_id: childAgentId, role: 'child' }];
        }
        continue;
      }
      const agentTaskId = `agent_${tool.toolCallId}`;
      if (tasks.has(agentTaskId)) continue;
      const args = (tool.input ?? {}) as Record<string, unknown>;
      const summary =
        outputText === undefined
          ? undefined
          : /\[summary\]\n([\s\S]*?)(?:\n\nresume_hint:|$)/.exec(outputText)?.[1]?.trim();
      const status = tool.status === 'done' ? 'completed' : 'failed';
      tasks.set(agentTaskId, {
        taskId: agentTaskId,
        kind: 'subagent',
        status,
        detached: args['run_in_background'] === true,
        description: typeof args['description'] === 'string' ? args['description'] : undefined,
        childAgentId,
        outputTail: '',
        startedAt: new Date(tool.at).toISOString(),
        endedAt: tool.status === 'running' ? undefined : new Date(tool.at).toISOString(),
        resultSummary:
          tool.status === 'done' && summary !== undefined && summary.length > 0
            ? summary
            : undefined,
        error: tool.status === 'error' ? (tool.error ?? outputText) : undefined,
        stateReason: tool.status === 'running' ? 'interrupted' : undefined,
        usage: undefined,
        model: typeof args['model'] === 'string' ? args['model'] : undefined,
        thinkingEffort: typeof args['thinking'] === 'string' ? args['thinking'] : undefined,
        at: tool.at,
      });
      tool.taskId = agentTaskId;
      if (childAgentId !== undefined && !tool.agentRefs.some((ref) => ref.agent_id === childAgentId)) {
        tool.agentRefs = [...tool.agentRefs, { agent_id: childAgentId, role: 'child' }];
      }
      const toolIndex = order.indexOf(`tool:${tool.toolCallId}`);
      if (toolIndex >= 0) order.splice(toolIndex + 1, 0, `task:${agentTaskId}`);
      else order.push(`task:${agentTaskId}`);
    }
  };
  synthesizeSubagentTasks();

  const messages: HistoryMessage[] = [];
  for (const key of order) {
    const [kind, id] = splitKey(key);
    switch (kind) {
      case 'turn': {
        const draft = turns.get(id);
        if (draft === undefined) break;
        const usage = turnUsageOf(id);
        messages.push({
          type: 'turn',
          ...baseFields(options, draft.at),
          turn_id: draft.turnId,
          ordinal: draft.rawId,
          status: finalTurnStatus(draft),
          origin: draft.origin,
          user_message_id: draft.userMessageId,
          attachment_ids: draft.attachmentIds,
          started_at: draft.startedAt,
          ended_at: draft.endedAt,
          usage: usage === undefined ? undefined : turnUsageToWire(usage),
          duration_ms: draft.durationMs,
        });
        break;
      }
      case 'step': {
        const draft = steps.get(id);
        if (draft === undefined) break;
        messages.push({
          type: 'step',
          ...baseFields(options, draft.at),
          step_id: draft.stepId,
          turn_id: draft.turnId,
          ordinal: draft.ordinal,
          status: finalStepStatus(draft),
          started_at: draft.startedAt,
          ended_at: draft.endedAt,
          usage: draft.usage,
          finish_reason: draft.finishReason,
          timing: draft.timing,
          retry: draft.retry,
          end_reason: draft.endReason,
          end_message: draft.endMessage,
        });
        break;
      }
      case 'user': {
        const draft = users.get(id);
        if (draft === undefined) break;
        messages.push({
          type: 'user',
          session_id: options.sessionId,
          agent_id: options.agentId,
          message_id: draft.messageId,
          turn_id: draft.turnId,
          status: draft.timestamp === undefined ? 'unread' : 'read',
          timestamp: draft.timestamp,
          text: draft.text,
          attachment_ids: draft.attachmentIds,
          skill_activations: draft.skillActivations,
          origin: draft.origin,
        });
        break;
      }
      case 'text': {
        const draft = texts.get(id);
        if (draft === undefined) break;
        const step = steps.get(draft.stepId);
        const streaming =
          options.live && step !== undefined && finalStepStatus(step) === 'running';
        const body = {
          ...baseFields(options, draft.at),
          message_id: draft.messageId,
          turn_id: draft.turnId,
          step_id: draft.stepId,
          status: (streaming ? 'streaming' : 'completed') as 'streaming' | 'completed',
          text: draft.text,
        };
        if (draft.kind === 'assistant') messages.push({ type: 'assistant', ...body });
        else messages.push({ type: 'thinking', ...body });
        break;
      }
      case 'tool': {
        const draft = tools.get(id);
        if (draft === undefined) break;
        messages.push({
          type: 'tool_call',
          ...baseFields(options, draft.at),
          tool_call_id: draft.toolCallId,
          turn_id: draft.turnId,
          step_id: draft.stepId,
          name: draft.name,
          status: draft.status === 'running' && !options.live ? 'done' : draft.status,
          input: draft.input,
          input_text: draft.inputText,
          output: draft.output,
          error: draft.error,
          task_id: draft.taskId,
          approval_id: draft.approvalId,
          todo_id: draft.todoId,
          agent_refs: draft.agentRefs.length > 0 ? draft.agentRefs : undefined,
        });
        break;
      }
      case 'sys': {
        const draft = systems.get(id);
        if (draft === undefined) break;
        messages.push({
          type: 'system',
          ...baseFields(options, draft.atMs),
          system_id: draft.systemId,
          subtype: draft.subtype,
          payload: draft.payload,
          at: draft.at,
        } as HistoryMessage);
        break;
      }
      case 'ix': {
        const draft = interactions.get(id);
        if (draft === undefined) break;
        const status =
          draft.status === 'pending' && !options.live ? ('cancelled' as const) : draft.status;
        messages.push({
          type: 'interaction',
          ...baseFields(options, draft.at),
          interaction_id: draft.interactionId,
          kind: draft.kind,
          status,
          tool_call_id: draft.toolCallId,
          request: draft.request,
          response: draft.response,
        } as HistoryMessage);
        break;
      }
      case 'task': {
        const draft = tasks.get(id);
        if (draft === undefined) break;
        messages.push({
          type: 'task',
          ...baseFields(options, draft.at),
          task_id: draft.taskId,
          kind: draft.kind,
          status: draft.status,
          detached: draft.detached,
          description: draft.description,
          child_agent_id: draft.childAgentId,
          output_tail: draft.outputTail,
          started_at: draft.startedAt,
          ended_at: draft.endedAt,
          result_summary: draft.resultSummary,
          error: draft.error,
          state_reason: draft.stateReason,
          usage: draft.usage,
          model: draft.model,
          thinking_effort: draft.thinkingEffort,
        });
        break;
      }
      default:
        break;
    }
  }
  let lastTodoTool: ToolDraft | undefined;
  for (const tool of tools.values()) {
    if (tool.todoId !== undefined && tool.status === 'done') lastTodoTool = tool;
  }
  if (lastTodoTool !== undefined) {
    const items = todoWriteItems(lastTodoTool.input);
    if (items !== undefined) {
      messages.push({
        type: 'todo',
        ...baseFields(options, lastAtMs),
        todo_id: TODO_ENTITY_ID,
        items: items.map((item) => ({ title: item.title, status: item.status })),
        updated_at: new Date(lastTodoTool.at).toISOString(),
      });
    }
  }
  return messages;
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf(':');
  return [key.slice(0, index), key.slice(index + 1)];
}

function baseFields(
  options: ColdFoldOptions,
  timestamp: number,
): { session_id: string; agent_id: string; timestamp: number } {
  return { session_id: options.sessionId, agent_id: options.agentId, timestamp };
}

function parseNotificationXmlText(text: string): TaskNotificationPayload | undefined {
  const match = text.match(/^<notification\s+([^>]*)>\n?/);
  if (!match) return undefined;
  const attrs = match[1]!;
  const attr = (name: string): string | undefined =>
    attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  const rest = text.slice(match[0].length).replace(/\n?<\/notification>\s*$/, '');
  let title = '';
  let severity: string | undefined;
  const bodyLines: string[] = [];
  for (const line of rest.split('\n')) {
    if (line.startsWith('Title: ')) title = line.slice('Title: '.length);
    else if (line.startsWith('Severity: ')) severity = line.slice('Severity: '.length);
    else bodyLines.push(line);
  }
  return {
    title,
    body: bodyLines.join('\n').replaceAll(/^\n+|\n+$/g, ''),
    severity,
    type: attr('type'),
    source_kind: attr('source_kind'),
    source_id: attr('source_id'),
    agent_id: attr('agent_id'),
    raw: text,
  };
}

function bundledSkillCount(origin: unknown): number {
  const candidate = origin as
    | { kind?: unknown; skillActivations?: readonly unknown[] }
    | null
    | undefined;
  if (candidate?.kind !== 'user') return 0;
  return candidate.skillActivations?.length ?? 0;
}

function turnPromptText(input: readonly ContentPart[], skipBlocks: number): string | undefined {
  const text = input
    .filter((part): part is ContentPart & { type: 'text' } => part.type === 'text')
    .slice(skipBlocks)
    .map((part) => part.text)
    .join('');
  return text.length > 0 ? text : undefined;
}

function promptAttachmentCount(input: readonly ContentPart[], origin: unknown): number {
  let count = 0;
  for (const part of input) {
    if (part.type === 'image_url') {
      if (mediaFileId(part.imageUrl.url, part.imageUrl.id) !== undefined) count += 1;
    } else if (part.type === 'video_url') {
      if (mediaFileId(part.videoUrl.url, part.videoUrl.id) !== undefined) count += 1;
    } else if (part.type === 'audio_url') {
      if (mediaFileId(part.audioUrl.url, part.audioUrl.id) !== undefined) count += 1;
    }
  }
  const candidate = origin as
    | { kind?: unknown; attachments?: readonly unknown[] }
    | null
    | undefined;
  if (candidate?.kind === 'user' || candidate?.kind === 'skill_activation') {
    count += candidate.attachments?.length ?? 0;
  }
  return count;
}

function mediaFileId(url: string, id: string | undefined): string | undefined {
  const fileId = parseDaemonFileUrl(url)?.fileId;
  if (id === undefined) return fileId;
  return fileId === id ? id : undefined;
}

function resolveStepRef(
  stepRefs: ReadonlyMap<string, { turn: number; step: number }>,
  stepUuid: string,
  turnId: string | undefined,
  step: number | undefined,
): { turn: number; step: number } | undefined {
  const direct = stepRefs.get(stepUuid);
  if (direct !== undefined) return direct;
  if (turnId === undefined || step === undefined) return undefined;
  const turn = Number(turnId);
  if (!Number.isInteger(turn)) return undefined;
  return { turn, step };
}

function toSnakeUsage(usage: TokenUsage): StepUsage {
  return {
    input_other: usage.inputOther,
    output: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

function turnUsageToWire(usage: StepUsage): {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
} {
  return {
    input_tokens: usage.input_other + usage.input_cache_creation,
    output_tokens: usage.output,
    cached_tokens: usage.input_cache_read,
  };
}

function mapTaskKind(kind: unknown): TaskMessage['kind'] {
  switch (kind) {
    case 'process':
      return 'shell';
    case 'agent':
      return 'subagent';
    default:
      return 'other';
  }
}

function epochMsToIso(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

function goalPayloadOf(goal: GoalState): Record<string, unknown> {
  return {
    objective: goal.objective,
    status: goal.status,
    completion_criterion: goal.completionCriterion,
    budget_used: goal.budgetUsed,
    budget_limit: goal.budgetLimit,
  };
}

function compactionSummaryText(record: ContextRecord): string {
  const summary = record['summary'];
  if (typeof summary === 'string') return summary;
  const contextSummary = record['contextSummary'];
  if (typeof contextSummary === 'string') return contextSummary;
  if (summary !== null && typeof summary === 'object' && !Array.isArray(summary)) {
    const content = (summary as { content?: unknown }).content;
    if (Array.isArray(content)) return promptTextOf(content as ContentPart[]);
  }
  return '';
}
