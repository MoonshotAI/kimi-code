import type {
  AgentReplayRecord,
  BackgroundTaskInfo,
  ContentPart,
  ContextMessage,
  PromptOrigin,
  ResumedAgentState,
  ToolCall,
} from '@moonshot-ai/kimi-code-sdk';

import type {
  AppState,
  BackgroundAgentMetadata,
  ToolCallBlockData,
  TranscriptEntry,
} from '#/tui/types';

import { mediaUrlPartToText } from './media-url';
import { nextTranscriptId } from './transcript-id';

export const REPLAY_TURN_LIMIT = 10;

export interface ReplayRenderContext {
  turnIndex: number;
  stepIndex: number;
  currentTurnId: string | undefined;
  assistant: {
    thinking: string[];
    text: string[];
  };
  toolCalls: Map<string, ToolCallBlockData>;
  completedToolCallIds: Set<string>;
  skillActivationIds: Set<string>;
  suppressNextPlanModeOffNotice: boolean;
}

export interface SkillActivationProjection {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
}

export interface ReplayBackgroundProjection {
  readonly backgroundAgents: ReadonlySet<string>;
  readonly backgroundAgentMetadata: ReadonlyMap<string, BackgroundAgentMetadata>;
}

export function appStateFromResumeAgent(agent: ResumedAgentState): Partial<AppState> {
  const maxContextTokens = agent.config.modelCapabilities?.max_context_tokens ?? 0;
  const contextTokens = agent.context.tokenCount;
  const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;
  return {
    model: agent.config.modelAlias ?? agent.config.provider?.model ?? '',
    contextTokens,
    maxContextTokens,
    contextUsage,
    planMode: agent.plan !== null,
    yolo: agent.permission.mode === 'yolo',
    permissionMode: agent.permission.mode,
  };
}

export function isTerminalBackgroundTask(info: BackgroundTaskInfo): boolean {
  return (
    info.status === 'completed' ||
    info.status === 'failed' ||
    info.status === 'killed' ||
    info.status === 'lost'
  );
}

export function countActiveBackgroundTasks(tasks: ReadonlyMap<string, BackgroundTaskInfo>): {
  bashTasks: number;
  agentTasks: number;
} {
  let bashTasks = 0;
  let agentTasks = 0;
  for (const info of tasks.values()) {
    if (isTerminalBackgroundTask(info)) continue;
    if (info.taskId.startsWith('agent-')) {
      agentTasks += 1;
    } else {
      bashTasks += 1;
    }
  }
  return { bashTasks, agentTasks };
}

export function replayBackgroundProjection(
  background: readonly BackgroundTaskInfo[],
): ReplayBackgroundProjection {
  const backgroundAgents = new Set<string>();
  const backgroundAgentMetadata = new Map<string, BackgroundAgentMetadata>();
  for (const info of background) {
    if (!info.taskId.startsWith('agent-')) continue;
    if (isTerminalBackgroundTask(info)) continue;
    backgroundAgents.add(info.taskId);
    backgroundAgentMetadata.set(info.taskId, {
      agentId: info.taskId,
      parentToolCallId: info.taskId,
      description: info.description,
    });
  }
  return { backgroundAgents, backgroundAgentMetadata };
}

export function createReplayRenderContext(): ReplayRenderContext {
  return {
    turnIndex: 0,
    stepIndex: 0,
    currentTurnId: undefined,
    assistant: { thinking: [], text: [] },
    toolCalls: new Map(),
    completedToolCallIds: new Set(),
    skillActivationIds: new Set(),
    suppressNextPlanModeOffNotice: false,
  };
}

export function limitReplayRecordsByTurn(
  records: readonly AgentReplayRecord[],
  maxTurns: number,
): readonly AgentReplayRecord[] {
  if (maxTurns <= 0) return [];
  const turnStarts = records.flatMap((record, index) =>
    isReplayUserTurnRecord(record) ? [index] : [],
  );
  if (turnStarts.length <= maxTurns) return records;
  return records.slice(turnStarts[turnStarts.length - maxTurns]);
}

export function replayEntry(
  context: ReplayRenderContext,
  kind: TranscriptEntry['kind'],
  content: string,
  renderMode: TranscriptEntry['renderMode'],
  extras: { detail?: string } = {},
): TranscriptEntry {
  return {
    id: nextTranscriptId(),
    kind,
    turnId: context.currentTurnId,
    renderMode,
    content,
    detail: extras.detail,
  };
}

export function collectReplayMessageContent(
  target: ReplayRenderContext['assistant'],
  content: readonly ContentPart[],
): void {
  for (const part of content) {
    switch (part.type) {
      case 'think':
        target.thinking.push(part.think);
        break;
      case 'text':
        target.text.push(part.text);
        break;
      case 'audio_url':
      case 'image_url':
      case 'video_url':
        break;
    }
  }
}

export function toolCallFromReplayMessage(
  rawToolCall: ToolCall,
  context: ReplayRenderContext,
): ToolCallBlockData | undefined {
  const id = rawToolCall.id;
  const name = rawToolCall.name;
  if (id.length === 0 || name.length === 0) return undefined;
  return {
    id,
    name,
    args: parseReplayToolArguments(rawToolCall.arguments),
    step: context.stepIndex,
    turnId: context.currentTurnId,
  };
}

export function toolResultOutput(content: readonly ContentPart[]): string {
  if (content.some((part) => part.type !== 'text')) {
    return JSON.stringify(content);
  }
  return contentPartsToText(content);
}

export function contentPartsToText(content: readonly ContentPart[]): string {
  return content.map(contentPartToText).join('');
}

export function backgroundOrigin(
  message: ContextMessage,
): Extract<PromptOrigin, { kind: 'background_task' }> | undefined {
  return message.origin?.kind === 'background_task' ? message.origin : undefined;
}

export function skillActivationFromOrigin(
  origin: PromptOrigin | undefined,
): SkillActivationProjection | undefined {
  if (origin?.kind !== 'skill_activation') return undefined;
  return {
    activationId: origin.activationId,
    skillName: origin.skillName,
    skillArgs: origin.skillArgs,
  };
}

export function formatHookResultMessageForTranscript(
  text: string,
  fallbackEvent: string,
  blocked: boolean,
): string {
  const results: Array<{ event: string; body: string }> = [];
  let lastIndex = 0;

  for (const match of text.matchAll(HOOK_RESULT_RE)) {
    if (text.slice(lastIndex, match.index).trim().length > 0) {
      return formatHookResultBlock(fallbackEvent, text, blocked);
    }
    const event = match[1];
    const body = match[2];
    if (event === undefined || body === undefined) {
      return formatHookResultBlock(fallbackEvent, text, blocked);
    }
    results.push({ event, body });
    lastIndex = match.index + match[0].length;
  }

  if (results.length === 0 || text.slice(lastIndex).trim().length > 0) {
    return formatHookResultBlock(fallbackEvent, text, blocked);
  }

  return results.map(({ event, body }) => formatHookResultBlock(event, body, blocked)).join('\n\n');
}

function isReplayUserTurnRecord(record: AgentReplayRecord): boolean {
  if (record.type !== 'message') return false;
  const { message } = record;
  if (message.role !== 'user') return false;
  switch (message.origin?.kind) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
      return message.origin.trigger === 'user-slash';
    case 'background_task':
    case 'compaction_summary':
    case 'hook_result':
    case 'injection':
    case 'system_trigger':
      return false;
  }
}

function parseReplayToolArguments(value: string | null): Record<string, unknown> {
  if (value === null || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function contentPartToText(part: ContentPart): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'think':
      return part.think;
    case 'image_url':
      return mediaUrlPartToText('image', part.imageUrl.url);
    case 'video_url':
      return mediaUrlPartToText('video', part.videoUrl.url);
    case 'audio_url':
      return mediaUrlPartToText('audio', part.audioUrl.url);
  }
}

const HOOK_RESULT_RE =
  /<hook_result\s+hook_event="([^"]+)">\n?([\s\S]*?)\n?<\/hook_result>/g;

function formatHookResultBlock(event: string, body: string, blocked: boolean): string {
  return `*${event} hook${blocked ? ' blocked' : ''}*\n\n${body.trim() || '(empty)'}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
