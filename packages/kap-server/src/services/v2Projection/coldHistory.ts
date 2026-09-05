import type {
  ServerMessage,
  SkillActivation,
  StepUsage,
  TaskMessage,
  TaskNotificationPayload,
  ToolCallAgentRef,
  TurnOrigin,
  UserMessageOrigin,
} from '../../protocol/v2/messages/index';
import {
  normalizeTodoToolCall,
  textFromContent,
  toSkillActivations,
  toStepUsage,
  toTaskKind,
  toTurnOrigin,
  toUserOrigin,
  todoItemsFromInput,
} from './agentProjector';
import { toWireInteractionRequest, toWireInteractionResponse } from './interactionWire';

export interface ColdWireRecord {
  type: string;
  time?: number;
  promptId?: unknown;
  createdAt?: unknown;
  origin?: unknown;
  input?: unknown;
  finishedAt?: unknown;
  abortedAt?: unknown;
  event?: unknown;
  turnId?: unknown;
  step?: unknown;
  reason?: unknown;
  message?: unknown;
  usage?: unknown;
  durationMs?: unknown;
  id?: unknown;
  kind?: unknown;
  toolCallId?: unknown;
  request?: unknown;
  response?: unknown;
  info?: unknown;
  outputTail?: unknown;
  fromTurnId?: unknown;
  tokensBefore?: unknown;
  tokensAfter?: unknown;
  summary?: unknown;
  [key: string]: unknown;
}

export interface ColdHistoryQuery {
  beforeTurn?: string;
  afterStep?: string;
  pageSize?: number;
}

export interface ColdInFlight {
  turn_id: string;
  step_id?: string;
}

export interface ColdHistoryPage {
  session_id: string;
  items: ServerMessage[];
  has_more: boolean;
  in_flight: ColdInFlight | null;
}

const COVER_SEAL_OFFSET_MS = 5;
const DEFAULT_PAGE_SIZE = 50;

interface PromptAcc {
  acceptedTime?: number;
  createdAt?: string;
  finishedAt?: string;
}

interface TextAcc {
  kind: 'assistant' | 'thinking';
  seq: number;
  text: string;
  firstTime?: number;
  lastTime?: number;
}

interface ToolAcc {
  toolCallId: string;
  name: string;
  input?: unknown;
  callTime?: number;
  resultTime?: number;
  output?: unknown;
  isError?: boolean;
  approvalId?: string;
  todoId?: string;
  agentRefs?: ToolCallAgentRef[];
}

interface InteractionAcc {
  id: string;
  kind: 'approval' | 'question';
  toolCallId?: string;
  request: unknown;
  requestTime?: number;
  response?: unknown;
  resolvedTime?: number;
}

interface SystemAcc {
  subtype: 'interruption' | 'undo' | 'goal';
  payload: Record<string, unknown>;
  time?: number;
  recordIndex: number;
}

interface StepAcc {
  turn: TurnAcc;
  uuid?: string;
  ordinal: number;
  beginTime?: number;
  endTime?: number;
  finishReason?: string;
  usage?: StepUsage;
  timing?: { llm_first_token_ms?: number; llm_stream_duration_ms?: number };
  interrupted?: { time?: number; reason?: string; message?: string };
  dropped: boolean;
  firstRecordIndex: number;
  texts: TextAcc[];
  openText?: TextAcc;
  textSeq: { a: number; h: number };
  toolCalls: ToolAcc[];
  interactions: InteractionAcc[];
  systems: SystemAcc[];
}

interface UserAcc {
  turn: TurnAcc;
  promptId?: string;
  seq: number;
  text: string;
  acceptedTime?: number;
  steeredAt?: string;
  origin?: UserMessageOrigin;
  notification?: TaskNotificationPayload;
  skillActivations?: SkillActivation[];
  sortTime?: number;
}

interface TurnAcc {
  ordinal: number;
  origin: TurnOrigin;
  promptId?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  firstRecordIndex: number;
  lastRecordIndex: number;
  steps: StepAcc[];
  users: UserAcc[];
}

interface TaskAcc {
  taskId: string;
  startedInfo?: Record<string, unknown>;
  startedTime?: number;
  terminatedInfo?: Record<string, unknown>;
  outputTail?: string;
  terminatedTime?: number;
  lastTime?: number;
}

function iso(time: number | undefined): string {
  return new Date(time ?? 0).toISOString();
}

function asTime(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface SwarmResultRow {
  agentId?: string;
  item?: string;
  outcome?: string;
  body: string;
}

/** 解析 AgentSwarm 工具结果 XML（writer：agentSwarmTool.ts renderSwarmResults）的成员行。 */
function parseSwarmResultRows(xml: string): SwarmResultRow[] {
  const rows: SwarmResultRow[] = [];
  const re = /<subagent\b([^>]*)>([\s\S]*?)<\/subagent>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    rows.push({
      agentId: xmlAttr(match[1] ?? '', 'agent_id'),
      item: xmlAttr(match[1] ?? '', 'item'),
      outcome: xmlAttr(match[1] ?? '', 'outcome'),
      body: match[2] ?? '',
    });
  }
  return rows;
}

function xmlAttr(attrs: string, name: string): string | undefined {
  const value = new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
  return value
    ?.replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function isDisplayableTurnOrigin(origin: TurnOrigin): boolean {
  return (
    origin.kind === 'user' ||
    origin.kind === 'cron' ||
    origin.kind === 'side' ||
    origin.kind === 'task' ||
    origin.kind === 'skill'
  );
}

function userDisplayText(input: unknown, origin: unknown): string {
  const parts = Array.isArray(input) ? input : [];
  const o = origin as { kind?: string; skillActivations?: unknown[] } | undefined;
  const bundled = o?.kind === 'user' ? (o.skillActivations?.length ?? 0) : 0;
  return textFromContent(parts.slice(bundled));
}

function parseNotificationXmlText(text: string): TaskNotificationPayload | undefined {
  const match = text.match(/^<notification\s+([^>]*)>\n?/);
  if (!match) return undefined;
  const attrs = match[1]!;
  const attr = (name: string): string | undefined => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
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
    body: bodyLines.join('\n').replace(/^\n+|\n+$/g, ''),
    severity,
    type: attr('type'),
    source_kind: attr('source_kind'),
    source_id: attr('source_id'),
    agent_id: attr('agent_id'),
    raw: text,
  };
}

interface LoopEventPayload {
  type: string;
  uuid?: string;
  turnId?: string;
  step?: number;
  stepUuid?: string;
  finishReason?: string;
  usage?: unknown;
  llmFirstTokenLatencyMs?: number;
  llmStreamDurationMs?: number;
  part?: unknown;
  toolCallId?: string;
  name?: string;
  args?: unknown;
  extras?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export function buildColdHistory(
  sessionId: string,
  agentId: string,
  records: readonly ColdWireRecord[],
  query: ColdHistoryQuery = {},
): ColdHistoryPage {
  const prompts = new Map<string, PromptAcc>();
  const turns: TurnAcc[] = [];
  const tools = new Map<string, { acc: ToolAcc; step: StepAcc }>();
  const stepByUuid = new Map<string, StepAcc>();
  const interactions = new Map<string, InteractionAcc>();
  const tasks = new Map<string, TaskAcc>();
  const looseSystems: SystemAcc[] = [];
  const allSteps: StepAcc[] = [];
  let latestStep: StepAcc | undefined;
  let floorIndex = -1;
  let floorTime: number | undefined;
  let compactionRecord: ColdWireRecord | undefined;
  let todoId: string | undefined;
  let todoSeq = 0;

  const turnByOrdinal = (ordinal: number): TurnAcc | undefined => turns.find((turn) => turn.ordinal === ordinal);
  const latestTurn = (): TurnAcc | undefined => turns.at(-1);

  const sealOpenText = (step: StepAcc): void => {
    if (!step.openText) return;
    step.texts.push(step.openText);
    step.openText = undefined;
  };

  const stepForContent = (uuid: unknown): StepAcc | undefined => {
    if (typeof uuid === 'string') {
      const hit = stepByUuid.get(uuid);
      if (hit) return hit;
    }
    return latestStep;
  };

  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex]!;
    const time = asTime(record.time);
    switch (record.type) {
      case 'prompt.accepted': {
        const promptId = asText(record.promptId);
        if (!promptId) break;
        prompts.set(promptId, { acceptedTime: time, createdAt: asText(record.createdAt) });
        break;
      }
      case 'turn.prompt': {
        const originValue = record.origin;
        const origin = toTurnOrigin(originValue);
        const turn: TurnAcc = {
          ordinal: turns.length,
          origin,
          promptId: asText(record.promptId),
          startedAt: time,
          firstRecordIndex: recordIndex,
          lastRecordIndex: recordIndex,
          steps: [],
          users: [],
        };
        turns.push(turn);
        if (isDisplayableTurnOrigin(origin)) {
          const rawText = userDisplayText(record.input, originValue);
          const notification = origin.kind === 'task' ? parseNotificationXmlText(rawText) : undefined;
          turn.users.push({
            turn,
            promptId: turn.promptId,
            seq: 0,
            text: notification ? `${notification.title}\n${notification.body}`.trim() : rawText,
            acceptedTime: time,
            origin: toUserOrigin(originValue),
            notification,
            skillActivations: toSkillActivations(originValue),
          });
        }
        break;
      }
      case 'turn.steer': {
        const turn = latestTurn();
        if (!turn) break;
        const origin = toUserOrigin(record.origin);
        if (origin?.kind === 'skill' && origin.trigger !== 'user-slash') break;
        const rawText = textFromContent(record.input);
        const notification = origin?.kind === 'task' ? parseNotificationXmlText(rawText) : undefined;
        turn.users.push({
          turn,
          seq: turn.users.length,
          text: notification ? `${notification.title}\n${notification.body}`.trim() : rawText,
          acceptedTime: time,
          steeredAt: iso(time),
          origin,
          notification,
          sortTime: time,
        });
        turn.lastRecordIndex = recordIndex;
        break;
      }
      case 'context.append_message': {
        const message = asRecord(record.message);
        const origin = toUserOrigin(message?.['origin']);
        if (origin?.kind !== 'task') break;
        const turn = latestTurn();
        if (!turn) break;
        const rawText = textFromContent(message?.['content']);
        const notification = parseNotificationXmlText(rawText);
        turn.users.push({
          turn,
          seq: turn.users.length,
          text: notification ? `${notification.title}\n${notification.body}`.trim() : rawText,
          acceptedTime: time,
          origin,
          notification,
          sortTime: time,
        });
        turn.lastRecordIndex = recordIndex;
        break;
      }
      case 'prompt.completed':
      case 'prompt.aborted': {
        const promptId = asText(record.promptId);
        const prompt = promptId ? prompts.get(promptId) : undefined;
        if (prompt && prompt.finishedAt === undefined) {
          prompt.finishedAt = asText(record.finishedAt) ?? asText(record.abortedAt) ?? iso(time);
        }
        if (record.type === 'prompt.aborted') {
          const turn = turns.find((candidate) => candidate.promptId === promptId) ?? latestTurn();
          looseSystems.push({
            subtype: 'interruption',
            payload: { reason: 'aborted', turn_id: turn ? `t${turn.ordinal + 1}` : undefined },
            time,
            recordIndex,
          });
        }
        break;
      }
      case 'context.append_loop_event': {
        const event = record.event as LoopEventPayload | undefined;
        if (!event) break;
        const eventType = event.type;
        if (eventType === 'step.begin') {
          const parsed = typeof event.turnId === 'string' ? Number.parseInt(event.turnId, 10) : undefined;
          const turn = (parsed !== undefined && Number.isInteger(parsed) ? turnByOrdinal(parsed) : undefined) ?? latestTurn();
          if (!turn) break;
          const ordinal = typeof event.step === 'number' ? event.step - 1 : turn.steps.length;
          const open = turn.steps.at(-1);
          if (open && open.endTime === undefined && !open.interrupted) {
            if (open.dropped && ordinal === open.ordinal) {
              open.dropped = false;
              open.uuid = event.uuid ?? open.uuid;
              open.texts = [];
              open.openText = undefined;
              open.textSeq = { a: 0, h: 0 };
              if (open.uuid) stepByUuid.set(open.uuid, open);
              turn.lastRecordIndex = recordIndex;
              latestStep = open;
              break;
            }
            open.dropped = true;
          }
          const step: StepAcc = {
            turn,
            uuid: event.uuid,
            ordinal,
            beginTime: time,
            dropped: false,
            firstRecordIndex: recordIndex,
            texts: [],
            textSeq: { a: 0, h: 0 },
            toolCalls: [],
            interactions: [],
            systems: [],
          };
          turn.steps.push(step);
          turn.lastRecordIndex = recordIndex;
          if (step.uuid) stepByUuid.set(step.uuid, step);
          allSteps.push(step);
          latestStep = step;
        } else if (eventType === 'step.end') {
          const step = stepForContent(event.uuid);
          if (!step) break;
          const finishReason = event.finishReason;
          if (finishReason === 'interrupted' || finishReason === 'error') {
            step.dropped = true;
          } else {
            sealOpenText(step);
            step.endTime = time;
            step.finishReason = finishReason;
            step.usage = toStepUsage(event.usage);
            const timing = {
              llm_first_token_ms: asTime(event.llmFirstTokenLatencyMs),
              llm_stream_duration_ms: asTime(event.llmStreamDurationMs),
            };
            step.timing =
              timing.llm_first_token_ms !== undefined || timing.llm_stream_duration_ms !== undefined ? timing : undefined;
          }
          step.turn.lastRecordIndex = recordIndex;
        } else if (eventType === 'content.part') {
          const step = stepForContent(event.stepUuid);
          if (!step || step.dropped) break;
          const part = asRecord(event.part);
          const partType = asText(part?.['type']);
          const kind = partType === 'think' ? 'thinking' : partType === 'text' ? 'assistant' : undefined;
          if (!kind) break;
          const text = kind === 'thinking' ? asText(part?.['think']) ?? '' : asText(part?.['text']) ?? '';
          if (text.length === 0) break;
          if (!step.openText || step.openText.kind !== kind) {
            sealOpenText(step);
            const seq = kind === 'assistant' ? step.textSeq.a++ : step.textSeq.h++;
            step.openText = { kind, seq, text: '', firstTime: time, lastTime: time };
          }
          step.openText.text += text;
          step.openText.lastTime = time;
        } else if (eventType === 'tool.call') {
          const step = stepForContent(event.stepUuid);
          if (!step) break;
          sealOpenText(step);
          const toolCallId = event.toolCallId;
          if (!toolCallId) break;
          const normalized = normalizeTodoToolCall(event.name ?? '', event.args);
          const acc: ToolAcc = {
            toolCallId,
            name: normalized.name,
            input: normalized.input,
            callTime: time,
            agentRefs: event.extras?.['agentRefs'] as ToolCallAgentRef[] | undefined,
          };
          if (acc.name === 'TodoWrite' && todoItemsFromInput(acc.input) !== undefined) {
            todoId = todoId ?? `td_${String(++todoSeq).padStart(2, '0')}`;
            acc.todoId = todoId;
          }
          step.toolCalls.push(acc);
          tools.set(toolCallId, { acc, step });
        } else if (eventType === 'tool.result') {
          const toolCallId = event.toolCallId;
          const hit = toolCallId ? tools.get(toolCallId) : undefined;
          if (!hit) break;
          const result = event.result;
          hit.acc.isError = result?.['isError'] === true;
          hit.acc.output = result?.['output'];
          hit.acc.resultTime = time;
          hit.step.turn.lastRecordIndex = recordIndex;
        }
        break;
      }
      case 'turn.step.interrupted': {
        const ordinal = asTime(record.turnId);
        const turn = ordinal !== undefined ? turnByOrdinal(ordinal) : latestTurn();
        if (!turn) break;
        const stepOrdinal = asTime(record.step);
        const step = turn.steps.find((candidate) => candidate.ordinal === (stepOrdinal === undefined ? undefined : stepOrdinal - 1)) ?? turn.steps.at(-1);
        if (!step) break;
        sealOpenText(step);
        step.dropped = false;
        step.interrupted = {
          time,
          reason: asText(record.reason),
          message: asText(record.message),
        };
        turn.lastRecordIndex = recordIndex;
        break;
      }
      case 'turn.ended': {
        const ordinal = asTime(record.turnId);
        const turn = ordinal !== undefined ? turnByOrdinal(ordinal) : latestTurn();
        if (!turn) break;
        turn.endedAt = time;
        turn.durationMs = asTime(record.durationMs);
        turn.lastRecordIndex = recordIndex;
        break;
      }
      case 'interaction.request': {
        const id = asText(record.id);
        if (!id) break;
        const kind = record.kind === 'question' ? ('question' as const) : ('approval' as const);
        const toolCallId = asText(record.toolCallId);
        const toolArgs = toolCallId !== undefined ? tools.get(toolCallId)?.acc.input : undefined;
        const acc: InteractionAcc = { id, kind, toolCallId, request: toWireInteractionRequest(kind, record.request, toolArgs), requestTime: time };
        const toolStep = toolCallId !== undefined ? tools.get(toolCallId)?.step : undefined;
        const step = toolStep ?? latestStep;
        if (!step) break;
        step.interactions.push(acc);
        interactions.set(id, acc);
        if (toolCallId !== undefined) {
          const tool = tools.get(toolCallId);
          if (tool) tool.acc.approvalId = id;
        }
        break;
      }
      case 'interaction.resolved': {
        const id = asText(record.id);
        const acc = id ? interactions.get(id) : undefined;
        if (!acc) break;
        acc.response = toWireInteractionResponse(acc.kind, record.response);
        acc.resolvedTime = time;
        break;
      }
      case 'task.started': {
        const info = asRecord(record.info);
        const taskId = asText(info?.['taskId']);
        if (!taskId) break;
        tasks.set(taskId, { taskId, startedInfo: info, startedTime: time, lastTime: time });
        break;
      }
      case 'task.terminated': {
        const info = asRecord(record.info);
        const taskId = asText(info?.['taskId']);
        if (!taskId) break;
        const prev = tasks.get(taskId);
        tasks.set(taskId, {
          taskId,
          startedInfo: prev?.startedInfo,
          startedTime: prev?.startedTime,
          terminatedInfo: info,
          outputTail: asText(record.outputTail),
          terminatedTime: time,
          lastTime: time,
        });
        break;
      }
      case 'context.undo':
        break;
      case 'context.undone': {
        const fromTurnId = asTime(record.fromTurnId);
        looseSystems.push({
          subtype: 'undo',
          payload: fromTurnId !== undefined ? { undo_turn_id: `t${fromTurnId + 1}` } : {},
          time,
          recordIndex,
        });
        break;
      }
      case 'goal.create': {
        looseSystems.push({
          subtype: 'goal',
          payload: { status: 'active', objective: asText(record['objective']) },
          time,
          recordIndex,
        });
        break;
      }
      case 'goal.update':
      case 'goal.clear': {
        break;
      }
      case 'context.apply_compaction': {
        floorIndex = recordIndex;
        floorTime = time;
        compactionRecord = record;
        break;
      }
      case 'context.clear': {
        floorIndex = recordIndex;
        floorTime = time;
        compactionRecord = undefined;
        break;
      }
      default:
        break;
    }
  }

  for (const system of looseSystems) {
    const step = allSteps.findLast((candidate) => !candidate.dropped && candidate.firstRecordIndex <= system.recordIndex);
    (step ?? latestStep)?.systems.push(system);
  }

  const systemIds = new Map<SystemAcc, string>();
  let compactionSystemId: string | undefined;
  {
    const ordered: { recordIndex: number; acc?: SystemAcc }[] = looseSystems.map((acc) => ({ recordIndex: acc.recordIndex, acc }));
    if (compactionRecord !== undefined) ordered.push({ recordIndex: floorIndex });
    ordered.sort((a, b) => a.recordIndex - b.recordIndex);
    let seq = 0;
    for (const entry of ordered) {
      seq += 1;
      const id = `m_${String(seq).padStart(2, '0')}`;
      if (entry.acc) systemIds.set(entry.acc, id);
      else compactionSystemId = id;
    }
  }

  const keptTurns = query.beforeTurn !== undefined ? turns : turns.filter((turn) => turn.lastRecordIndex > floorIndex);

  interface FlatUnit {
    pos: number;
    seq: number;
    items: ServerMessage[];
    turnOrdinal?: number;
    stepGroups: { stepId: string; coverOffset: number; itemCount: number }[];
  }
  const units: FlatUnit[] = [];
  let unitSeq = 0;

  const userMessageFor = (user: UserAcc, turnId: string): ServerMessage => {
    const prompt = user.promptId !== undefined ? prompts.get(user.promptId) : undefined;
    const finishedAt = prompt?.finishedAt ?? (user.turn.endedAt !== undefined ? iso(user.turn.endedAt) : undefined);
    return {
      type: 'user',
      session_id: sessionId,
      agent_id: agentId,
      timestamp: iso(prompt?.acceptedTime ?? user.acceptedTime),
      message_id: `${turnId}.u${user.seq}`,
      turn_id: turnId,
      text: user.text,
      status: finishedAt !== undefined ? 'completed' : 'running',
      created_at: prompt?.createdAt ?? iso(prompt?.acceptedTime ?? user.acceptedTime),
      finished_at: finishedAt,
      steered_at: user.steeredAt,
      origin: user.origin,
      notification: user.notification,
      skill_activations: user.skillActivations,
    } as ServerMessage;
  };

  if (compactionRecord !== undefined) {
    const through = (() => {
      const prior = turns.filter((turn) => turn.lastRecordIndex < floorIndex);
      const highest = prior.length > 0 ? Math.max(...prior.map((turn) => turn.ordinal)) : -1;
      return highest >= 0 ? `t${highest + 1}` : undefined;
    })();
    units.push({
      pos: Number.NEGATIVE_INFINITY,
      seq: unitSeq++,
      items: [
        {
          type: 'system',
          session_id: sessionId,
          agent_id: agentId,
          timestamp: iso(asTime(compactionRecord.time)),
          system_id: compactionSystemId ?? 'm_01',
          subtype: 'compaction',
          payload: {
            state: 'completed',
            before_tokens: asTime(compactionRecord.tokensBefore) ?? 0,
            after_tokens: asTime(compactionRecord.tokensAfter) ?? 0,
            summarized_through_turn: through,
            summary: asText(compactionRecord.summary),
          },
        } as ServerMessage,
      ],
      stepGroups: [],
    });
  }

  for (const turn of keptTurns) {
    const turnId = `t${turn.ordinal + 1}`;
    const groupItems: ServerMessage[] = [];
    const stepGroups: { stepId: string; coverOffset: number; itemCount: number }[] = [];
    if (turn.endedAt !== undefined) {
      let usageInput = 0;
      let usageOutput = 0;
      for (const step of turn.steps) {
        if (step.dropped || step.endTime === undefined || !step.usage) continue;
        usageInput += step.usage.input_other;
        usageOutput += step.usage.output;
      }
      groupItems.push({
        type: 'turn',
        session_id: sessionId,
        agent_id: agentId,
        timestamp: iso(turn.endedAt + COVER_SEAL_OFFSET_MS),
        turn_id: turnId,
        ordinal: turn.ordinal,
        state: 'completed',
        origin: turn.origin,
        user_message_id: turn.users.length > 0 ? `${turnId}.u${turn.users[0]!.seq}` : undefined,
        started_at: iso(turn.startedAt),
        ended_at: iso(turn.endedAt),
        usage: usageInput > 0 || usageOutput > 0 ? { input_tokens: usageInput, output_tokens: usageOutput } : undefined,
        duration_ms: turn.durationMs,
      } as ServerMessage);
    }
    const visibleSteps = turn.steps.filter((step) => !step.dropped && (step.endTime !== undefined || step.interrupted));
    const timedUsers = turn.users
      .filter((candidate) => candidate.sortTime !== undefined)
      .slice()
      .sort((a, b) => (a.sortTime ?? 0) - (b.sortTime ?? 0));
    let timedUserCursor = 0;
    let openingUsersPlaced = false;
    for (const step of visibleSteps) {
      const stepId = `${turnId}.${step.ordinal}`;
      const stepItems: ServerMessage[] = [];
      const sealTime = step.interrupted ? (step.interrupted.time ?? step.beginTime) : (step.endTime ?? step.beginTime);
      const sealTimestamp = sealTime === undefined ? undefined : iso(sealTime + COVER_SEAL_OFFSET_MS);
      if (step.interrupted) {
        stepItems.push({
          type: 'step',
          session_id: sessionId,
          agent_id: agentId,
          timestamp: sealTimestamp ?? iso(step.beginTime),
          step_id: stepId,
          turn_id: turnId,
          ordinal: step.ordinal,
          state: 'interrupted',
          started_at: iso(step.beginTime),
          ended_at: iso(step.interrupted.time),
          end_reason: step.interrupted.reason,
          end_message: step.interrupted.message,
        } as ServerMessage);
      } else {
        stepItems.push({
          type: 'step',
          session_id: sessionId,
          agent_id: agentId,
          timestamp: sealTimestamp ?? iso(step.beginTime),
          step_id: stepId,
          turn_id: turnId,
          ordinal: step.ordinal,
          state: 'completed',
          started_at: iso(step.beginTime),
          ended_at: iso(step.endTime),
          usage: step.usage,
          finish_reason: step.finishReason,
          timing: step.timing,
        } as ServerMessage);
      }
      const content: { time: number; msg: ServerMessage }[] = [];
      if (!openingUsersPlaced) {
        for (const user of turn.users.filter((candidate) => candidate.sortTime === undefined)) {
          content.push({ time: step.beginTime ?? 0, msg: userMessageFor(user, turnId) });
        }
        openingUsersPlaced = true;
      }
      while (timedUserCursor < timedUsers.length) {
        const user = timedUsers[timedUserCursor]!;
        const userTime = user.sortTime ?? 0;
        const isLastStep = step === visibleSteps[visibleSteps.length - 1];
        if (!isLastStep && step.endTime !== undefined && userTime > step.endTime) break;
        content.push({ time: userTime, msg: userMessageFor(user, turnId) });
        timedUserCursor += 1;
      }
      for (const text of step.texts) {
        content.push({
          time: text.firstTime ?? 0,
          msg: {
            type: text.kind,
            session_id: sessionId,
            agent_id: agentId,
            timestamp: iso(text.lastTime),
            message_id: `${stepId}.${text.kind === 'assistant' ? 'a' : 'h'}${text.seq}`,
            turn_id: turnId,
            step_id: stepId,
            status: 'completed',
            text: text.text,
          } as ServerMessage,
        });
      }
      for (const tool of step.toolCalls) {
        const isError = tool.isError === true;
        const display =
          tool.approvalId === undefined
            ? undefined
            : (interactions.get(tool.approvalId)?.request as { display?: unknown } | undefined)?.display;
        content.push({
          time: tool.callTime ?? 0,
          msg: {
            type: 'tool_call',
            session_id: sessionId,
            agent_id: agentId,
            timestamp: iso(tool.resultTime ?? tool.callTime),
            tool_call_id: tool.toolCallId,
            turn_id: turnId,
            step_id: stepId,
            name: tool.name,
            state: isError ? 'error' : 'done',
            input: tool.input,
            output: isError ? undefined : tool.output,
            error: isError ? (typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output)) : undefined,
            display,
            approval_id: tool.approvalId,
            todo_id: tool.todoId,
            agent_refs: tool.agentRefs,
          } as ServerMessage,
        });
      }
      for (const interaction of step.interactions) {
        const response = interaction.response;
        const state =
          interaction.kind === 'question'
            ? response === null || response === undefined
              ? ('dismissed' as const)
              : ('answered' as const)
            : ((): 'approved' | 'rejected' | 'cancelled' => {
                const decision = asRecord(response)?.['decision'];
                return decision === 'approved' || decision === 'rejected' || decision === 'cancelled' ? decision : 'cancelled';
              })();
        content.push({
          time: interaction.requestTime ?? 0,
          msg: {
            type: 'interaction',
            session_id: sessionId,
            agent_id: agentId,
            timestamp: iso(interaction.resolvedTime ?? interaction.requestTime),
            interaction_id: interaction.id,
            kind: interaction.kind,
            state,
            tool_call_id: interaction.toolCallId,
            request: interaction.request,
            response: interaction.response,
          } as ServerMessage,
        });
      }
      for (const system of step.systems) {
        content.push({
          time: system.time ?? 0,
          msg: {
            type: 'system',
            session_id: sessionId,
            agent_id: agentId,
            timestamp: iso(system.time),
            system_id: systemIds.get(system) ?? 'm_01',
            subtype: system.subtype,
            payload: system.payload,
          } as ServerMessage,
        });
      }
      content.sort((a, b) => a.time - b.time);
      stepItems.push(...content.map((entry) => entry.msg));
      stepGroups.push({ stepId, coverOffset: groupItems.length, itemCount: stepItems.length });
      groupItems.push(...stepItems);
    }
    units.push({ pos: turn.startedAt ?? 0, seq: unitSeq++, items: groupItems, turnOrdinal: turn.ordinal, stepGroups });
  }

  for (const task of tasks.values()) {
    const startedInfo = task.startedInfo;
    const terminatedInfo = task.terminatedInfo;
    const taskKind = toTaskKind(asText(terminatedInfo?.['kind']) ?? asText(startedInfo?.['kind']));
    const detached = startedInfo?.['detached'] === true || terminatedInfo?.['detached'] === true;
    // 前台 subagent 不发 task 实体（由下方 agent 实体承载）；detached 的保留后台句柄
    if (taskKind !== 'subagent' || detached) {
      const lastTime = task.terminatedTime ?? task.lastTime ?? task.startedTime;
      if (query.beforeTurn === undefined && lastTime !== undefined && floorTime !== undefined && lastTime <= floorTime) continue;
      units.push({
        pos: lastTime ?? 0,
        seq: unitSeq++,
        items: [
          {
            type: 'task',
            session_id: sessionId,
            agent_id: agentId,
            timestamp: iso(lastTime),
            task_id: task.taskId,
            kind: taskKind,
            state: (asText(terminatedInfo?.['status']) ?? 'running') as TaskMessage['state'],
            detached,
            description: asText(terminatedInfo?.['description']) ?? asText(startedInfo?.['description']),
            output_tail: task.outputTail ?? asText(terminatedInfo?.['outputTail']) ?? '',
            started_at: asText(startedInfo?.['startedAt']) ?? iso(task.startedTime),
            ended_at: terminatedInfo !== undefined ? asText(terminatedInfo['endedAt']) ?? iso(task.terminatedTime) : undefined,
            result_summary: asText(terminatedInfo?.['resultSummary']),
            error: asText(terminatedInfo?.['error']),
            state_reason: asText(terminatedInfo?.['stopReason']),
            usage: toStepUsage(terminatedInfo?.['usage']),
            model: asText(startedInfo?.['model']),
            thinking_effort: asText(startedInfo?.['thinkingEffort']),
            child_agent_id:
              asText(terminatedInfo?.['agentId']) ??
              asText(startedInfo?.['agentId']) ??
              asText(terminatedInfo?.['childAgentId']) ??
              asText(startedInfo?.['childAgentId']),
          } as ServerMessage,
        ],
        stepGroups: [],
      });
    }
    // 已注册的 subagent task（单 Agent 工具 / detached）终态 → agent 实体
    if (asText(startedInfo?.['kind']) === 'agent' && terminatedInfo !== undefined) {
      const subagentId = asText(startedInfo['agentId']) ?? asText(terminatedInfo['agentId']);
      if (subagentId !== undefined) {
        const status = asText(terminatedInfo['status']);
        const lastTime = task.terminatedTime ?? task.lastTime ?? task.startedTime;
        units.push({
          pos: lastTime ?? 0,
          seq: unitSeq++,
          items: [
            {
              type: 'agent',
              session_id: sessionId,
              agent_id: agentId,
              timestamp: iso(lastTime),
              subagent_id: subagentId,
              parent_tool_call_id: asText(startedInfo['parentToolCallId']) ?? asText(terminatedInfo['parentToolCallId']),
              subagent_type: asText(startedInfo['subagentType']) ?? 'subagent',
              description: asText(startedInfo['description']) ?? asText(terminatedInfo['description']),
              model: asText(startedInfo['model']),
              thinking_effort: asText(startedInfo['thinkingEffort']),
              detached,
              state: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled',
              task_id: task.taskId,
              result_summary: asText(terminatedInfo['resultSummary']),
              usage: toStepUsage(terminatedInfo['usage']),
              error: asText(terminatedInfo['error']),
              started_at: asText(startedInfo['startedAt']) ?? iso(task.startedTime),
              ended_at: asText(terminatedInfo['endedAt']) ?? iso(task.terminatedTime),
            } as ServerMessage,
          ],
          stepGroups: [],
        });
      }
    }
  }

  // AgentSwarm 工具结果 XML → 每成员 agent 实体（终态；非终态由直播恢复载荷覆盖）
  for (const { acc } of tools.values()) {
    if (acc.name !== 'AgentSwarm' || acc.isError === true) continue;
    const xml =
      asText(acc.output) ??
      (Array.isArray(acc.output)
        ? acc.output.filter((line): line is string => typeof line === 'string').join('\n')
        : undefined);
    if (xml === undefined || !xml.includes('<agent_swarm_result>')) continue;
    const input = asRecord(acc.input);
    const profile = asText(input?.['subagent_type']) ?? 'subagent';
    const swarmDescription = asText(input?.['description']);
    const rows = parseSwarmResultRows(xml);
    rows.forEach((row, index) => {
      const swarmIndex = index + 1;
      units.push({
        pos: acc.resultTime ?? acc.callTime ?? 0,
        seq: unitSeq++,
        items: [
          {
            type: 'agent',
            session_id: sessionId,
            agent_id: agentId,
            timestamp: iso(acc.resultTime ?? acc.callTime),
            subagent_id: row.agentId ?? `${acc.toolCallId}:${swarmIndex}`,
            parent_tool_call_id: acc.toolCallId,
            subagent_type: profile,
            description:
              swarmDescription !== undefined
                ? `${swarmDescription} #${swarmIndex} (${profile})`
                : (row.item ?? profile),
            model: asText(input?.['model']),
            swarm_index: swarmIndex,
            detached: false,
            state: row.outcome === 'completed' ? 'completed' : row.outcome === 'failed' ? 'failed' : 'cancelled',
            result_summary: row.outcome === 'completed' ? row.body : undefined,
            error: row.outcome === 'completed' ? undefined : row.body,
            started_at: iso(acc.callTime),
            ended_at: iso(acc.resultTime),
          } as ServerMessage,
        ],
        stepGroups: [],
      });
    });
  }

  units.sort((a, b) => a.pos - b.pos || a.seq - b.seq);

  const lastTurn = turns.at(-1);
  let inFlight: ColdInFlight | null = null;
  if (lastTurn && lastTurn.endedAt === undefined && lastTurn.lastRecordIndex > floorIndex) {
    const lastStep = lastTurn.steps.at(-1);
    inFlight = {
      turn_id: `t${lastTurn.ordinal + 1}`,
      step_id: lastStep ? `t${lastTurn.ordinal + 1}.${lastStep.ordinal}` : undefined,
    };
  }

  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

  if (query.afterStep !== undefined) {
    const items: ServerMessage[] = [];
    let found = false;
    for (const unit of units) {
      if (!found) {
        const groupIndex = unit.stepGroups.findIndex((group) => group.stepId === query.afterStep);
        if (groupIndex < 0) continue;
        found = true;
        const skip =
          unit.stepGroups[0]!.coverOffset + unit.stepGroups.slice(0, groupIndex + 1).reduce((sum, group) => sum + group.itemCount, 0);
        items.push(...unit.items.slice(skip));
        continue;
      }
      items.push(...unit.items);
    }
    return { session_id: sessionId, items, has_more: false, in_flight: inFlight };
  }

  if (query.beforeTurn !== undefined) {
    const unitIndex = units.findIndex((unit) => unit.turnOrdinal !== undefined && `t${unit.turnOrdinal + 1}` === query.beforeTurn);
    if (unitIndex < 0) return { session_id: sessionId, items: [], has_more: false, in_flight: inFlight };
    const before = units.slice(0, unitIndex);
    const turnUnits = before.filter((unit) => unit.turnOrdinal !== undefined);
    const startIndex = Math.max(0, turnUnits.length - pageSize);
    const kept = new Set(turnUnits.slice(startIndex));
    const items = before.filter((unit) => unit.turnOrdinal === undefined || kept.has(unit)).flatMap((unit) => unit.items);
    return { session_id: sessionId, items, has_more: startIndex > 0, in_flight: inFlight };
  }

  const turnUnits = units.filter((unit) => unit.turnOrdinal !== undefined);
  const startIndex = Math.max(0, turnUnits.length - pageSize);
  const kept = new Set(turnUnits.slice(startIndex));
  const items = units.filter((unit) => unit.turnOrdinal === undefined || kept.has(unit)).flatMap((unit) => unit.items);
  const floorDropped =
    turns.length - keptTurns.length > 0 ||
    [...tasks.values()].some((task) => floorTime !== undefined && (task.lastTime ?? 0) <= floorTime);
  return {
    session_id: sessionId,
    items,
    has_more: startIndex > 0 || (floorIndex >= 0 && floorDropped),
    in_flight: inFlight,
  };
}
