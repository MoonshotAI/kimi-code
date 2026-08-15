import type {
  AgentReplayRecord,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ContentPart,
  ContextMessage,
  PromptOrigin,
  ResumedAgentState,
  ToolCall,
} from '@moonshot-ai/kimi-code-sdk';
import { limitAgentReplayByTurns } from '@moonshot-ai/kimi-code-sdk';

import type {
  AppState,
  BackgroundAgentMetadata,
  SkillActivationTrigger,
  ToolCallBlockData,
  TranscriptEntry,
} from '#/tui/types';

import { modelDisplayName } from '../components/dialogs/model-selector';
import { mediaUrlPartToText } from './media-url';
import { nextTranscriptId } from './transcript-id';

export const REPLAY_TURN_LIMIT = 10;

/**
 * Resume fetches one extra turn of records: the SDK trims the replay to the
 * requested limit before returning it, and a trim that lands between a
 * bundled prompt and the hook results recorded immediately before it would
 * make them unrecoverable. The extra margin lets the TUI-side limiter
 * (session-replay's preserveBundleHookResults) do the final cut without
 * losing them.
 */
export const REPLAY_FETCH_TURN_LIMIT = REPLAY_TURN_LIMIT + 1;

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
  pluginCommandActivationIds: Set<string>;
  suppressNextPlanModeOffNotice: boolean;
}

export interface SkillActivationProjection {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly trigger: SkillActivationTrigger;
  /** The activation rode a bundled prompt message, not a standalone one. */
  readonly bundled?: boolean;
}

export interface PluginCommandProjection {
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string;
  readonly trigger: 'user-slash';
}

export interface ReplayBackgroundProjection {
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
    swarmMode: agent.swarmMode ?? false,
    permissionMode: agent.permission.mode,
  };
}

export function isTerminalBackgroundTask(info: BackgroundTaskInfo): boolean {
  return (
    info.status === 'completed' ||
    info.status === 'failed' ||
    info.status === 'timed_out' ||
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
    if (info.kind === 'agent') {
      agentTasks += 1;
    } else {
      bashTasks += 1;
    }
  }
  return { bashTasks, agentTasks };
}

export function replayBackgroundProjection(
  background: readonly BackgroundTaskInfo[],
  availableModels?: AppState['availableModels'],
): ReplayBackgroundProjection {
  const backgroundAgentMetadata = new Map<string, BackgroundAgentMetadata>();
  for (const info of background) {
    if (info.kind !== 'agent') continue;
    if (isTerminalBackgroundTask(info)) continue;
    const agentId = info.agentId ?? info.taskId;
    backgroundAgentMetadata.set(agentId, {
      agentId,
      parentToolCallId: info.taskId,
      description: info.description,
      // The persisted task record carries the spawn-time model/effort (v2);
      // keep them across a resume so the terminal transcript entry can show
      // them. Model maps through the catalog like the live path; boolean
      // effort states carry no level and are dropped.
      model:
        info.model === undefined
          ? undefined
          : modelDisplayName(info.model, availableModels?.[info.model]),
      effort:
        info.thinkingEffort === undefined ||
        info.thinkingEffort === 'off' ||
        info.thinkingEffort === 'on'
          ? undefined
          : info.thinkingEffort,
    });
  }
  return { backgroundAgentMetadata };
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
    pluginCommandActivationIds: new Set(),
    suppressNextPlanModeOffNotice: false,
  };
}

export function limitReplayRecordsByTurn(
  records: readonly AgentReplayRecord[],
  maxTurns: number,
): readonly AgentReplayRecord[] {
  // Defensive slice — the core already trims the replay when the caller passes
  // `replayTurnLimit` on resume; the boundary predicate lives in agent-core
  // (`limitAgentReplayByTurns`) and is re-exported through the SDK.
  return limitAgentReplayByTurns(records, maxTurns);
}

export function replayEntry(
  context: ReplayRenderContext,
  kind: TranscriptEntry['kind'],
  content: string,
  renderMode: TranscriptEntry['renderMode'],
  extras: { detail?: string; bullet?: string } = {},
): TranscriptEntry {
  return {
    id: nextTranscriptId(),
    kind,
    turnId: context.currentTurnId,
    renderMode,
    content,
    detail: extras.detail,
    bullet: extras.bullet,
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

/**
 * agent-core-v2's task domain persists the terminal notification under the
 * 'task' spelling (v1 used 'background_task'); both reach replay verbatim.
 */
export interface TaskNotificationOrigin {
  readonly kind: 'task';
  readonly taskId: string;
  readonly status: BackgroundTaskStatus;
  readonly notificationId: string;
}

export type BackgroundTaskNotificationOrigin =
  | Extract<PromptOrigin, { kind: 'background_task' }>
  | TaskNotificationOrigin;

export function backgroundOrigin(
  message: ContextMessage,
): BackgroundTaskNotificationOrigin | undefined {
  const origin = message.origin as BackgroundTaskNotificationOrigin | undefined;
  return origin?.kind === 'background_task' || origin?.kind === 'task' ? origin : undefined;
}

export function skillActivationFromOrigin(
  origin: PromptOrigin | undefined,
): SkillActivationProjection | undefined {
  if (origin?.kind !== 'skill_activation') return undefined;
  return {
    activationId: origin.activationId,
    skillName: origin.skillName,
    skillArgs: origin.skillArgs,
    trigger: origin.trigger,
  };
}

/**
 * The v2 engine bundles a prompt's inline skill activations into the prompt
 * message itself: the rendered skill blocks precede the caller's parts in
 * the content, and this origin field carries every activation's metadata so
 * replay can rebuild the per-skill cards from the single message. The SDK's
 * origin union is typed from the v1 engine, which never sets the field, so
 * read it structurally here instead of widening the deprecated v1 package's
 * types.
 */
export function bundledSkillsFromOrigin(
  origin: PromptOrigin | undefined,
): readonly SkillActivationProjection[] {
  if (origin?.kind !== 'user') return [];
  const activations = (
    origin as {
      readonly skillActivations?: readonly {
        readonly activationId: string;
        readonly skillName: string;
        readonly skillArgs?: string;
      }[];
    }
  ).skillActivations;
  if (activations === undefined) return [];
  return activations.map((activation) => ({
    activationId: activation.activationId,
    skillName: activation.skillName,
    skillArgs: activation.skillArgs,
    trigger: 'user-slash' as const,
    bundled: true,
  }));
}

/**
 * Content parts the caller actually typed: the engine prepends one rendered
 * text part per bundled skill, so the caller's own parts start right after
 * them.
 */
export function stripBundledSkillParts(message: ContextMessage): readonly ContentPart[] {
  const bundledCount = bundledSkillsFromOrigin(message.origin).length;
  return bundledCount === 0 ? message.content : message.content.slice(bundledCount);
}

export function pluginCommandFromOrigin(
  origin: PromptOrigin | undefined,
): PluginCommandProjection | undefined {
  if (origin?.kind !== 'plugin_command') return undefined;
  return {
    activationId: origin.activationId,
    pluginId: origin.pluginId,
    commandName: origin.commandName,
    commandArgs: origin.commandArgs,
    trigger: origin.trigger,
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
