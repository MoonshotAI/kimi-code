import {
  daemonFileRefFromPart,
  parseDaemonFileUrl,
  type TokenUsage,
} from '@moonshot-ai/agent-core-v2';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';

import type {
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
  mapInteractionEndState,
  notificationTextOf,
  parseToolArgs,
  promptTextOf,
  skillActivationsOf,
  taskNotificationOriginOf,
  todoWriteItems,
  toTurnOrigin,
  userOriginOf,
  wantsUserMessage,
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
  stepUserMessageIdOf,
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
  readonly fallbackTimestamp: string;
  readonly subagentTaskIds?: ReadonlyMap<string, string>;
  readonly resolvePlanRevisionKey?: (key: string) => string;
}

interface TurnDraft {
  readonly turnId: string;
  readonly rawId: number;
  readonly origin: TurnOrigin;
  state: 'running' | 'completed';
  userMessageId?: string;
  attachmentIds?: string[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  at: string;
}

interface StepDraft {
  readonly stepId: string;
  readonly turnId: string;
  readonly ordinal: number;
  state: 'running' | 'completed' | 'interrupted' | 'failed';
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
  at: string;
}

interface TextDraft {
  readonly messageId: string;
  readonly kind: 'assistant' | 'thinking';
  readonly turnId: string;
  readonly stepId: string;
  text: string;
  at: string;
}

interface ToolDraft {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly stepId: string;
  name: string;
  state: 'running' | 'done' | 'error';
  input?: unknown;
  inputText?: string;
  output?: unknown;
  error?: string;
  taskId?: string;
  approvalId?: string;
  todoId?: string;
  agentRefs: { agent_id: string; role?: 'child' | 'member' }[];
  at: string;
}

interface UserDraft {
  readonly messageId: string;
  readonly turnId: string;
  readonly stepId?: string;
  readonly text: string;
  status: 'running' | 'completed';
  createdAt: string;
  finishedAt?: string;
  steeredAt?: string;
  origin?: UserMessageOrigin;
  notification?: TaskNotificationPayload;
  attachmentIds?: string[];
  skillActivations?: { skill_name: string; skill_args?: string }[];
  at: string;
}

interface SystemDraft {
  readonly systemId: string;
  readonly subtype: SystemMessage['subtype'];
  readonly payload: unknown;
  readonly at?: string;
}

interface InteractionDraft {
  readonly interactionId: string;
  readonly kind: 'approval' | 'question';
  state: InteractionMessage['state'];
  toolCallId?: string;
  request?: unknown;
  response?: unknown;
  at: string;
}

interface TaskDraft {
  readonly taskId: string;
  readonly kind: TaskMessage['kind'];
  state: TaskMessage['state'];
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
  at: string;
}

interface PendingSteer {
  readonly input: readonly ContentPart[];
  readonly origin: UserMessageOrigin | undefined;
  readonly skillActivations: { skill_name: string; skill_args?: string }[] | undefined;
  readonly skipBlocks: number;
  readonly at: string;
  readonly notification?: { readonly payload: TaskNotificationPayload; readonly text: string };
}

interface TurnScratch {
  currentStep?: number;
  userSeq: number;
  attachmentSeq: number;
  pendingSteers: PendingSteer[];
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

const TASK_STATES = new Set<TaskMessage['state']>([
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

  const queuedPrompts = new Map<string, { content: readonly ContentPart[]; at: string }>();

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
  let lastAt = options.fallbackTimestamp;

  const at = (record: ContextRecord): string => {
    const time = record.time;
    if (typeof time === 'number' && Number.isFinite(time)) {
      lastAt = new Date(time).toISOString();
    }
    return lastAt;
  };

  const scratch = (rawId: number): TurnScratch => {
    let entry = scratchByTurn.get(rawId);
    if (entry === undefined) {
      entry = { userSeq: 0, attachmentSeq: 0, pendingSteers: [], openingSteerDeduped: false };
      scratchByTurn.set(rawId, entry);
    }
    return entry;
  };

  const pushSystem = (
    subtype: DurableSystemSubtype,
    payload: unknown,
    recordAt: string,
  ): void => {
    const systemId = sysIds.next(subtype);
    systems.set(systemId, { systemId, subtype, payload, at: recordAt });
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
    recordAt: string,
  ): TextDraft => {
    const seq = (stepTextSeqs.get(stepId) ?? 0) + 1;
    stepTextSeqs.set(stepId, seq);
    const draft: TextDraft = {
      messageId: textMessageIdOf(stepId, seq),
      kind,
      turnId,
      stepId,
      text: '',
      at: recordAt,
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
    recordAt: string,
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
      state: 'running',
      startedAt: recordAt,
      at: recordAt,
    };
    steps.set(stepId, draft);
    order.push(`step:${stepId}`);
    return draft;
  };

  const emitSteer = (rawId: number, step: StepDraft, steer: PendingSteer): void => {
    const turnId = turnIdOf(rawId);
    const entry = scratch(rawId);
    entry.userSeq += 1;
    const messageId = stepUserMessageIdOf(step.stepId, entry.userSeq);
    const textsOut: string[] = [];
    const attachmentIds: string[] = [];
    for (const part of steer.input.slice(steer.skipBlocks)) {
      if (part.type === 'text') {
        textsOut.push(part.text);
        continue;
      }
      if (daemonFileRefFromPart(part) === undefined) continue;
      entry.attachmentSeq += 1;
      attachmentIds.push(attachmentIdOf(step.stepId, entry.attachmentSeq));
    }
    const draft: UserDraft = {
      messageId,
      turnId,
      stepId: step.stepId,
      text: steer.notification?.text ?? textsOut.join(''),
      status: 'running',
      createdAt: steer.at,
      steeredAt: steer.at,
      origin: steer.origin,
      notification: steer.notification?.payload,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      skillActivations: steer.skillActivations,
      at: steer.at,
    };
    users.set(messageId, draft);
    order.push(`user:${messageId}`);
  };

  const flushSteers = (rawId: number, step: StepDraft): void => {
    const entry = scratch(rawId);
    for (const steer of entry.pendingSteers) emitSteer(rawId, step, steer);
    entry.pendingSteers = [];
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
    const rawId = nextTurnId;
    nextTurnId += 1;
    phantomUserSeq = 0;
    const origin = record['origin'];
    const promptId = record['promptId'];
    if (typeof promptId === 'string') {
      turnPromptIds.set(rawId, promptId);
      queuedPrompts.delete(promptId);
    }
    if (isUndoAnchorOrigin(origin)) pendingAnchorTurnIds.push(rawId);
    currentTurn = rawId;
    if (!isVisibleTurnOrigin(origin)) {
      hiddenTurnIds.add(rawId);
      return;
    }
    const recordAt = at(record);
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
    const draft: TurnDraft = {
      turnId,
      rawId,
      origin: toTurnOrigin(origin, options.agentId, subagentTaskIds),
      state: 'running',
      userMessageId: wantsUser || taskOrigin !== undefined ? turnUserMessageIdOf(turnId) : undefined,
      attachmentIds,
      startedAt: recordAt,
      at: recordAt,
    };
    turns.set(turnId, draft);
    order.push(`turn:${turnId}`);
    timelineIds.push(turnId);
    scratchByTurn.set(rawId, {
      userSeq: 0,
      attachmentSeq: 0,
      pendingSteers: [],
      openingInputKey: JSON.stringify(input),
      openingSteerDeduped: false,
    });
    if (draft.userMessageId !== undefined) {
      const notification =
        taskOrigin === undefined ? undefined : parseNotificationXmlText(promptText ?? '');
      const user: UserDraft = {
        messageId: draft.userMessageId,
        turnId,
        text: notification === undefined ? (promptText ?? '') : notificationTextOf(notification),
        status: 'running',
        createdAt: recordAt,
        origin: taskOrigin ?? userOriginOf(origin),
        notification,
        attachmentIds,
        skillActivations: skillActivationsOf(origin),
        at: recordAt,
      };
      users.set(user.messageId, user);
      order.push(`user:${user.messageId}`);
    }
    emitSkillSystems(origin, input, recordAt, pushSystem);
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
    const steer: PendingSteer = {
      input,
      origin: userOriginOf(origin),
      skillActivations: skillActivationsOf(origin),
      skipBlocks: kind === 'user' ? (origin?.skillActivations?.length ?? 0) : 0,
      at: at(record),
    };
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
    const stepOrdinal = entry.currentStep;
    if (stepOrdinal !== undefined) {
      const step = steps.get(stepIdOf(turnIdOf(rawId), stepOrdinal));
      if (step !== undefined && step.state === 'running') {
        emitSteer(rawId, step, steer);
        return;
      }
    }
    entry.pendingSteers.push(steer);
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
        const draft = ensureStepDraft(turn, e.step, at(record));
        if (draft === undefined) return;
        draft.startedAt = draft.startedAt ?? at(record);
        const entry = scratch(turn);
        entry.currentStep = e.step;
        entry.userSeq = 0;
        entry.attachmentSeq = 0;
        currentTurn = turn;
        flushSteers(turn, draft);
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
        draft.state = 'completed';
        draft.endedAt = at(record);
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
        draft.at = at(record);
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
        const draft = ensureStepDraft(ref.turn, ref.step, at(record));
        if (draft === undefined) return;
        const kind = e.part.type === 'text' ? 'assistant' : e.part.type === 'think' ? 'thinking' : undefined;
        const partText = e.part.type === 'think' ? e.part.think : e.part.text;
        if (kind === undefined || typeof partText !== 'string') return;
        const stepId = draft.stepId;
        const existingId = stepTextIds.get(stepId)?.[kind];
        const text = existingId === undefined ? undefined : texts.get(existingId);
        const target = text ?? createTextDraft(stepId, draft.turnId, kind, at(record));
        target.text += partText;
        target.at = at(record);
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
        const draft = ensureStepDraft(ref.turn, ref.step, at(record));
        if (draft === undefined) return;
        const existing = tools.get(e.toolCallId);
        const input = parseToolArgs(e.args);
        const tool: ToolDraft = {
          toolCallId: e.toolCallId,
          turnId: draft.turnId,
          stepId: draft.stepId,
          name: e.name,
          state: existing?.state ?? 'running',
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
          at: at(record),
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
        existing.state = isError ? 'error' : 'done';
        existing.output = e.result.output;
        existing.error = isError && typeof e.result.output === 'string' ? e.result.output : undefined;
        existing.at = at(record);
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
    const recordAt = at(record);
    const input = Array.isArray(message.content) ? message.content : [];
    const rawText = promptTextOf(input);
    const notification = parseNotificationXmlText(rawText);
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
      if (turn !== undefined && turn.state === 'running') {
        const steer: PendingSteer = {
          input,
          origin: taskOrigin,
          skillActivations: undefined,
          skipBlocks: 0,
          at: recordAt,
          notification:
            notification === undefined
              ? undefined
              : { payload: notification, text: notificationTextOf(notification) },
        };
        const stepOrdinal = entry?.currentStep;
        if (stepOrdinal !== undefined) {
          const step = steps.get(stepIdOf(turnId, stepOrdinal));
          if (step !== undefined && step.state === 'running') {
            emitSteer(rawId, step, steer);
            return;
          }
        }
        scratch(rawId).pendingSteers.push(steer);
        return;
      }
    }
    phantomUserSeq += 1;
    const turnId = turnIdOf(nextTurnId);
    const draft: UserDraft = {
      messageId: `${turnId}.u${phantomUserSeq}`,
      turnId,
      text: notification === undefined ? rawText : notificationTextOf(notification),
      status: 'completed',
      createdAt: recordAt,
      origin: taskOrigin,
      notification,
      at: recordAt,
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
      const recordAt = at(record);
      let rawId = currentTurn;
      if (rawId === undefined || hiddenTurnIds.has(rawId) || !turns.has(turnIdOf(rawId))) {
        rawId = nextTurnId;
        nextTurnId += 1;
        const turnId = turnIdOf(rawId);
        const draft: TurnDraft = {
          turnId,
          rawId,
          origin: { kind: 'other' },
          state: 'running',
          startedAt: recordAt,
          at: recordAt,
        };
        turns.set(turnId, draft);
        order.push(`turn:${turnId}`);
        timelineIds.push(turnId);
        currentTurn = rawId;
        scratchByTurn.set(rawId, {
          userSeq: 0,
          attachmentSeq: 0,
          pendingSteers: [],
          openingSteerDeduped: false,
        });
      }
      const entry = scratch(rawId);
      const ordinal = (entry.currentStep ?? 0) + 1;
      const step = ensureStepDraft(rawId, ordinal, recordAt);
      if (step === undefined) return;
      entry.currentStep = ordinal;
      step.state = 'completed';
      step.endedAt = recordAt;
      step.at = recordAt;
      for (const part of message.content ?? []) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          const existingId = stepTextIds.get(step.stepId)?.assistant;
          const target =
            (existingId === undefined ? undefined : texts.get(existingId)) ??
            createTextDraft(step.stepId, step.turnId, 'assistant', recordAt);
          target.text += part.text;
          target.at = recordAt;
        } else if (part.type === 'think') {
          const think = (part as { think?: unknown }).think;
          if (typeof think !== 'string' || think.length === 0) continue;
          const existingId = stepTextIds.get(step.stepId)?.thinking;
          const target =
            (existingId === undefined ? undefined : texts.get(existingId)) ??
            createTextDraft(step.stepId, step.turnId, 'thinking', recordAt);
          target.text += think;
          target.at = recordAt;
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
          state: 'running',
          input,
          inputText: typeof call.arguments === 'string' ? call.arguments : undefined,
          taskId: taskIdByToolCall(call.id),
          todoId:
            call.name === 'TodoList' && todoWriteItems(input) !== undefined
              ? TODO_ENTITY_ID
              : undefined,
          agentRefs: agentRefsOf(call.id),
          at: recordAt,
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
      existing.state = isError ? 'error' : 'done';
      existing.output = output;
      existing.error = isError ? output : undefined;
      existing.at = at(record);
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
    const recordAt = at(record);
    const reason = record['reason'];
    const entry = scratch(rawId);
    let step =
      entry.currentStep === undefined
        ? undefined
        : steps.get(stepIdOf(turnIdOf(rawId), entry.currentStep));
    if (step === undefined && entry.pendingSteers.length > 0) {
      const ordinal = (entry.currentStep ?? 0) + 1;
      step = ensureStepDraft(rawId, ordinal, recordAt);
      entry.currentStep = ordinal;
    }
    if (step !== undefined && step.state === 'running') {
      step.state = reason === 'failed' || reason === 'blocked' ? 'failed' : 'interrupted';
      step.endedAt = recordAt;
      step.at = recordAt;
    }
    if (step !== undefined) flushSteers(rawId, step);
    entry.pendingSteers = [];
    draft.state = 'completed';
    draft.endedAt = recordAt;
    draft.durationMs = typeof record['durationMs'] === 'number' ? record['durationMs'] : undefined;
    draft.at = recordAt;
    for (const user of users.values()) {
      if (user.turnId !== draft.turnId || user.status !== 'running') continue;
      user.status = 'completed';
      user.finishedAt = recordAt;
      user.at = recordAt;
    }
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
    pushSystem('undo', { removed_ids: removed }, at(record));
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
    pushSystem('clear', { removed_ids: removed }, at(record));
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
    const recordAt = at(record);
    const draft: InteractionDraft = {
      interactionId: id,
      kind,
      state: 'pending',
      toolCallId,
      request: wireInteractionRequest(kind, payload),
      at: recordAt,
    };
    interactions.set(id, draft);
    order.push(`ix:${id}`);
    if (toolCallId !== undefined) {
      const tool = tools.get(toolCallId);
      if (tool !== undefined && tool.approvalId !== id) {
        tool.approvalId = id;
        tool.at = recordAt;
      }
    }
  };

  const onInteractionResolved = (record: ContextRecord): void => {
    const id = record['id'];
    if (typeof id !== 'string') return;
    const draft = interactions.get(id);
    if (draft === undefined) return;
    const response = record['response'];
    draft.state = mapInteractionEndState(draft.kind, response);
    draft.response = wireInteractionResponse(draft.kind, draft.request, response);
    draft.at = at(record);
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
    const recordAt = at(record);
    const taskId = info.taskId;
    const prev = tasks.get(taskId);
    const status = info.status;
    const draft: TaskDraft = {
      taskId,
      kind: mapTaskKind(info.kind),
      state:
        typeof status === 'string' && TASK_STATES.has(status as TaskMessage['state'])
          ? (status as TaskMessage['state'])
          : (prev?.state ?? 'running'),
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
      at: recordAt,
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
      pushSystem('goal', goalPayloadOf(goal), at(record));
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
      pushSystem('goal', goal === undefined ? undefined : goalPayloadOf(goal), at(record));
      return;
    }
    goal = undefined;
    pushSystem('goal', undefined, at(record));
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
        const draft = ensureStepDraft(rawId, step, at(record));
        if (draft === undefined) break;
        draft.state = 'interrupted';
        draft.endedAt = at(record);
        draft.endReason = record['reason'];
        draft.endMessage = typeof record['message'] === 'string' ? record['message'] : undefined;
        draft.at = at(record);
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
        const draft = ensureStepDraft(rawId, step, at(record));
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
        draft.at = at(record);
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
          at(record),
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
          at(record),
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
        pushSystem('plan.enter', undefined, at(record));
        break;
      case 'plan_mode.exit':
        pushSystem('plan.exit', undefined, at(record));
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
          at(record),
        );
        break;
      }
      case 'swarm_mode.enter':
        pushSystem('swarm.enter', undefined, at(record));
        break;
      case 'swarm_mode.exit':
        pushSystem('swarm.exit', undefined, at(record));
        break;
      case 'prompt.accepted': {
        const promptId = record['promptId'];
        const content = record['content'];
        if (typeof promptId !== 'string' || !Array.isArray(content)) break;
        queuedPrompts.set(promptId, { content: content as ContentPart[], at: at(record) });
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
        for (const id of ids) {
          if (typeof id === 'string') queuedPrompts.delete(id);
        }
        break;
      }
      default:
        break;
    }
  }

  let queuedRawId = nextTurnId;
  for (const { content, at: acceptedAt } of queuedPrompts.values()) {
    while (cancelledTurnIds.delete(queuedRawId)) queuedRawId += 1;
    const turnId = turnIdOf(queuedRawId);
    queuedRawId += 1;
    const messageId = turnUserMessageIdOf(turnId);
    const draft: UserDraft = {
      messageId,
      turnId,
      text: promptTextOf(content),
      status: 'running',
      createdAt: acceptedAt,
      at: acceptedAt,
    };
    users.set(messageId, draft);
    order.push(`user:${messageId}`);
  }

  const finalTurnState = (draft: TurnDraft): 'running' | 'completed' =>
    draft.state === 'running' && options.live ? 'running' : 'completed';

  const finalStepState = (draft: StepDraft): StepDraft['state'] =>
    draft.state === 'running' && !options.live ? 'interrupted' : draft.state;

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
          state: finalTurnState(draft),
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
          state: finalStepState(draft),
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
          ...baseFields(options, draft.at),
          message_id: draft.messageId,
          turn_id: draft.turnId,
          step_id: draft.stepId,
          text: draft.text,
          attachment_ids: draft.attachmentIds,
          skill_activations: draft.skillActivations,
          status: draft.status === 'running' && !options.live ? 'completed' : draft.status,
          created_at: draft.createdAt,
          finished_at: draft.finishedAt,
          steered_at: draft.steeredAt,
          origin: draft.origin,
          notification: draft.notification,
        });
        break;
      }
      case 'text': {
        const draft = texts.get(id);
        if (draft === undefined) break;
        const step = steps.get(draft.stepId);
        const streaming =
          options.live && step !== undefined && finalStepState(step) === 'running';
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
          state: draft.state === 'running' && !options.live ? 'done' : draft.state,
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
          ...baseFields(options, draft.at ?? lastAt),
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
        const state =
          draft.state === 'pending' && !options.live ? ('cancelled' as const) : draft.state;
        messages.push({
          type: 'interaction',
          ...baseFields(options, draft.at),
          interaction_id: draft.interactionId,
          kind: draft.kind,
          state,
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
          state: draft.state,
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
    if (tool.todoId !== undefined && tool.state === 'done') lastTodoTool = tool;
  }
  if (lastTodoTool !== undefined) {
    const items = todoWriteItems(lastTodoTool.input);
    if (items !== undefined) {
      messages.push({
        type: 'todo',
        ...baseFields(options, lastAt),
        todo_id: TODO_ENTITY_ID,
        items: items.map((item) => ({ title: item.title, status: item.status })),
        updated_at: lastTodoTool.at,
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
  timestamp: string,
): { session_id: string; agent_id: string; timestamp: string } {
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

function emitSkillSystems(
  origin: unknown,
  input: readonly ContentPart[],
  recordAt: string,
  pushSystem: (subtype: DurableSystemSubtype, payload: unknown, at: string) => void,
): void {
  const candidate = origin as
    | {
        kind?: unknown;
        skillActivations?: readonly {
          activationId?: unknown;
          skillName?: unknown;
          skillArgs?: unknown;
          skillPath?: unknown;
          skillSource?: unknown;
        }[];
        activationId?: unknown;
        skillName?: unknown;
        skillArgs?: unknown;
        skillPath?: unknown;
        skillSource?: unknown;
        pluginId?: unknown;
        commandName?: unknown;
        commandArgs?: unknown;
        trigger?: unknown;
      }
    | null
    | undefined;
  if (candidate?.kind === 'user') {
    const activations = candidate.skillActivations ?? [];
    activations.forEach((activation, index) => {
      const block = input[index];
      pushSystem(
        'skill',
        {
          trigger: 'user-slash',
          activation_id: activation.activationId,
          skill_name: activation.skillName,
          skill_args: activation.skillArgs,
          skill_path: activation.skillPath,
          skill_source: activation.skillSource,
          text: block !== undefined && block.type === 'text' ? block.text : '',
        },
        recordAt,
      );
    });
    return;
  }
  if (candidate?.kind === 'skill_activation') {
    pushSystem(
      'skill',
      {
        trigger: candidate.trigger,
        activation_id: candidate.activationId,
        skill_name: candidate.skillName,
        skill_args: candidate.skillArgs,
        skill_path: candidate.skillPath,
        skill_source: candidate.skillSource,
      },
      recordAt,
    );
    return;
  }
  if (candidate?.kind === 'plugin_command') {
    pushSystem(
      'skill',
      {
        variant: 'plugin_command',
        trigger: candidate.trigger,
        activation_id: candidate.activationId,
        plugin_id: candidate.pluginId,
        command_name: candidate.commandName,
        command_args: candidate.commandArgs,
      },
      recordAt,
    );
  }
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
