/**
 * Local type/value copies from `@moonshot-ai/agent-core` (v1).
 *
 * These mirror the v1 engine's wire record types, compaction helpers, and
 * related utilities so `apps/vis/server` can operate without depending on
 * the legacy v1 engine package.  Only the subset used by vis is included.
 *
 * The v1 types are frozen — session files on disk are versioned by the wire
 * protocol, so a local copy stays in sync by definition.
 */

import type { ContentPart, Message, TokenUsage } from '@moonshot-ai/kosong';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';

// ════════════════════════════════════════════════════════════════════════════
// Wire protocol
// ════════════════════════════════════════════════════════════════════════════

export const AGENT_WIRE_PROTOCOL_VERSION = '1.4';

// ════════════════════════════════════════════════════════════════════════════
// Agent config
// ════════════════════════════════════════════════════════════════════════════

export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingEffort: string;
  systemPrompt: string;
}>;

// ════════════════════════════════════════════════════════════════════════════
// Compaction types
// ════════════════════════════════════════════════════════════════════════════

export type CompactionSource = 'manual' | 'auto';

export interface CompactionBeginData {
  instruction?: string;
  source: CompactionSource;
}

export interface CompactionResult {
  summary: string;
  contextSummary?: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  keptUserMessageCount?: number;
  keptHeadUserMessageCount?: number;
  droppedCount?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Permission types
// ════════════════════════════════════════════════════════════════════════════

export type PermissionMode = 'manual' | 'yolo' | 'auto';

export interface ApprovalResponse {
  decision: 'approved' | 'rejected' | 'cancelled';
  scope?: 'session';
  feedback?: string;
  selectedLabel?: string;
}

export interface PermissionApprovalResultRecord {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

// ════════════════════════════════════════════════════════════════════════════
// Usage
// ════════════════════════════════════════════════════════════════════════════

export type UsageRecordScope = 'session' | 'turn';

// ════════════════════════════════════════════════════════════════════════════
// Tool store
// ════════════════════════════════════════════════════════════════════════════

export interface ToolStoreData {}
export type ToolStoreKey = Extract<keyof ToolStoreData, string>;

export interface ToolStoreUpdate<K extends ToolStoreKey = ToolStoreKey> {
  readonly key: K;
  readonly value: ToolStoreData[K];
}

// ════════════════════════════════════════════════════════════════════════════
// Loop recorded events
// ════════════════════════════════════════════════════════════════════════════

export interface LoopStepBeginEvent {
  readonly type: 'step.begin';
  readonly uuid: string;
  readonly turnId: string;
  readonly step: number;
}

export interface LoopStepEndEvent {
  readonly type: 'step.end';
  readonly uuid: string;
  readonly turnId: string;
  readonly step: number;
  readonly usage?: TokenUsage | undefined;
  readonly finishReason?: string | undefined;
  readonly llmFirstTokenLatencyMs?: number | undefined;
  readonly llmStreamDurationMs?: number | undefined;
  readonly messageId?: string | undefined;
  readonly traceId?: string;
}

export interface LoopContentPartEvent {
  readonly type: 'content.part';
  readonly uuid: string;
  readonly turnId: string;
  readonly step: number;
  readonly stepUuid: string;
  readonly part: ContentPart;
}

export interface LoopToolCallEvent {
  readonly type: 'tool.call';
  readonly uuid: string;
  readonly turnId: string;
  readonly step: number;
  readonly stepUuid: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly description?: string | undefined;
  readonly display?: ToolInputDisplay | undefined;
  readonly extras?: Record<string, unknown> | undefined;
  readonly traceId?: string;
}

export interface LoopToolResultEvent {
  readonly type: 'tool.result';
  readonly parentUuid: string;
  readonly toolCallId: string;
  readonly result: ExecutableToolResult;
  readonly traceId?: string;
}

export type LoopRecordedEvent =
  | LoopStepBeginEvent
  | LoopStepEndEvent
  | LoopContentPartEvent
  | LoopToolCallEvent
  | LoopToolResultEvent;

// ════════════════════════════════════════════════════════════════════════════
// Executable tool result (used by LoopToolResultEvent + renderToolResultForModel)
// ════════════════════════════════════════════════════════════════════════════

export type ExecutableToolOutput = string | readonly ContentPart[];

export interface ExecutableToolSuccessResult {
  readonly output: ExecutableToolOutput;
  readonly isError?: false | undefined;
  readonly message?: string | undefined;
  readonly note?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export interface ExecutableToolErrorResult {
  readonly output: ExecutableToolOutput;
  readonly isError: true;
  readonly message?: string | undefined;
  readonly note?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export type ExecutableToolResult = ExecutableToolSuccessResult | ExecutableToolErrorResult;

// ════════════════════════════════════════════════════════════════════════════
// Background task types
// ════════════════════════════════════════════════════════════════════════════

export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface BackgroundTaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
}

export interface ProcessBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

export interface AgentBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly subagentType?: string;
}

export interface QuestionBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export type BackgroundTaskInfo =
  | ProcessBackgroundTaskInfo
  | AgentBackgroundTaskInfo
  | QuestionBackgroundTaskInfo;

// ════════════════════════════════════════════════════════════════════════════
// PromptOrigin
// ════════════════════════════════════════════════════════════════════════════

export interface UserPromptOrigin {
  readonly kind: 'user';
}

export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string | undefined;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillType?: string | undefined;
}

export interface PluginCommandOrigin {
  readonly kind: 'plugin_command';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string | undefined;
  readonly trigger: 'user-slash';
}

export interface InjectionOrigin {
  readonly kind: 'injection';
  readonly variant: string;
}

export interface ShellCommandOrigin {
  readonly kind: 'shell_command';
  readonly phase: 'input' | 'output';
  readonly isError?: boolean;
}

export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  readonly name: string;
}

export interface BackgroundTaskOrigin {
  readonly kind: 'background_task';
  readonly taskId: string;
  readonly status: BackgroundTaskStatus;
  readonly notificationId: string;
}

export interface CronJobOrigin {
  readonly kind: 'cron_job';
  readonly jobId: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly coalescedCount: number;
  readonly stale: boolean;
}

export interface CronMissedOrigin {
  readonly kind: 'cron_missed';
  readonly count: number;
}

export interface HookResultOrigin {
  readonly kind: 'hook_result';
  readonly event: string;
  readonly blocked?: boolean;
}

export interface RetryOrigin {
  readonly kind: 'retry';
  readonly trigger?: string;
}

export type PromptOrigin =
  | UserPromptOrigin
  | SkillActivationOrigin
  | PluginCommandOrigin
  | InjectionOrigin
  | ShellCommandOrigin
  | CompactionSummaryOrigin
  | SystemTriggerOrigin
  | BackgroundTaskOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin;

// ════════════════════════════════════════════════════════════════════════════
// ContextMessage
// ════════════════════════════════════════════════════════════════════════════

export type ContextMessage = Message & {
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
  readonly toolCallDisplays?: Record<string, ToolInputDisplay>;
  readonly note?: string;
};

// ════════════════════════════════════════════════════════════════════════════
// AgentRecord events map + derived record types
// ════════════════════════════════════════════════════════════════════════════

export interface AgentRecordEvents {
  metadata: {
    protocol_version: string;
    created_at: number;
  };
  forked: {};
  'turn.prompt': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.steer': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.cancel': { turnId?: number };
  'config.update': AgentConfigUpdateData;
  'permission.set_mode': {
    mode: PermissionMode;
  };
  'permission.record_approval_result': PermissionApprovalResultRecord;
  'full_compaction.begin': CompactionBeginData;
  'plan_mode.enter': { id: string };
  'plan_mode.cancel': { id?: string };
  'plan_mode.exit': { id?: string };
  'swarm_mode.enter': { trigger: string };
  'swarm_mode.exit': {};
  'tools.register_user_tool': { name: string; description?: string };
  'tools.unregister_user_tool': { name: string };
  'tools.set_active_tools': { names: readonly string[] };
  'usage.record': {
    model: string;
    usage: TokenUsage;
    usageScope?: UsageRecordScope | undefined;
  };
  'full_compaction.cancel': {};
  'full_compaction.complete': {};
  'micro_compaction.apply': { cutoff: number };
  'context.append_message': { message: ContextMessage };
  'context.append_loop_event': { event: LoopRecordedEvent };
  'context.update_token_count': { tokenCount: number };
  'context.clear': {};
  'context.apply_compaction': CompactionResult;
  'context.undo': { count: number };
  'tools.update_store': ToolStoreUpdate;
  'goal.create': {
    goalId: string;
    objective: string;
    completionCriterion?: string;
  };
  'goal.update': {
    status?: string;
    tokensUsed?: number;
    turnsUsed?: number;
    wallClockMs?: number;
    reason?: string;
    actor?: string;
  };
  'goal.clear': {};
  'llm.tools_snapshot': {
    hash: string;
    tools: readonly {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }[];
  };
  'llm.request': {
    kind: 'loop' | 'compaction';
    provider: string;
    model: string;
    modelAlias?: string;
    thinkingEffort?: string;
    maxTokens?: number;
    toolSelect: boolean;
    systemPromptHash: string;
    toolsHash: string;
    messageCount: number;
    turnStep?: string;
    attempt?: string;
    projection?: string;
    droppedCount?: number;
  };
  'mcp.tools_discovered': {
    serverName: string;
    hash: string;
    tools: readonly {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }[];
    enabledNames: readonly string[];
  };
}

export type AgentRecord = {
  [K in keyof AgentRecordEvents]: Readonly<AgentRecordEvents[K]> & {
    readonly type: K;
    readonly time?: number;
  };
}[keyof AgentRecordEvents];

export type AgentRecordOf<K extends keyof AgentRecordEvents> = Extract<
  AgentRecord,
  { readonly type: K }
>;

// ════════════════════════════════════════════════════════════════════════════
// Compaction handoff helpers
// ════════════════════════════════════════════════════════════════════════════

export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const COMPACTION_ELISION_VARIANT = 'compaction_elision';

export function buildCompactionElisionText(omittedTokens: number): string {
  return [
    '<system-reminder>',
    `Some of this conversation's user messages were omitted here during compaction: the messages above this note are the oldest user input, the messages below are the most recent, and roughly ${String(omittedTokens)} tokens in between were dropped. The omitted content is covered by the compaction summary at the end of the conversation.`,
    '</system-reminder>',
  ].join('\n');
}

function isCompactionSummaryMessage(message: {
  origin?: { kind?: string };
}): boolean {
  return message.origin?.kind === 'compaction_summary';
}

export function isRealUserInput(message: {
  role?: string;
  origin?: { kind?: string };
}): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined) return true;
  if (origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') {
    return false; // trigger check omitted — vis doesn't need it
  }
  return false;
}

export function collectCompactableUserMessages<
  T extends { role?: string; origin?: { kind?: string } },
>(messages: readonly T[]): T[] {
  return messages.filter(
    (message) => isRealUserInput(message) && !isCompactionSummaryMessage(message),
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Token estimation (simplified TS fallback, matching v1's heuristic)
// ════════════════════════════════════════════════════════════════════════════

export function estimateTokens(text: string): number {
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

// ── helpers used by the selection functions below ──────────────────────────

function estimateTokensForMessage(message: {
  role?: string;
  content?: readonly ContentPart[];
  toolCalls?: readonly { name: string; arguments: unknown }[];
}): number {
  let total = estimateTokens(message.role ?? '');
  for (const part of message.content ?? []) {
    if (part.type === 'text') {
      total += estimateTokens(part.text);
    } else if (part.type === 'think') {
      total += estimateTokens(part.think);
    }
  }
  if (message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name);
      total += estimateTokens(JSON.stringify(call.arguments));
    }
  }
  return total;
}

// ── public selection functions ────────────────────────────────────────────

function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let end = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
    if (Math.ceil(asciiCount / 4) + nonAsciiCount > maxTokens) break;
    end += char.length;
  }
  return text.slice(0, end);
}

function truncateTextToTokensFromEnd(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let start = text.length;
  for (let i = text.length - 1; i >= 0; i--) {
    let isAscii = false;
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      const high = text.charCodeAt(i - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        i--;
      }
    } else {
      isAscii = code <= 127;
    }
    if (isAscii) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
    if (Math.ceil(asciiCount / 4) + nonAsciiCount > maxTokens) break;
    start = i;
  }
  return text.slice(start);
}

function extractText(content: readonly ContentPart[]): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') {
      text += part.text;
    }
  }
  return text;
}

function replaceMessageText<T extends { content?: readonly ContentPart[]; toolCalls?: readonly unknown[] }>(
  message: T,
  text: string,
): T {
  return {
    ...message,
    content: [{ type: 'text' as const, text }],
    toolCalls: [],
  } as unknown as T;
}

export function selectRecentUserMessages<
  T extends {
    role?: string;
    content?: readonly ContentPart[];
    toolCalls?: readonly { name: string; arguments: unknown }[];
    origin?: { kind?: string };
  },
>(messages: readonly T[], maxTokens: number = COMPACT_USER_MESSAGE_MAX_TOKENS): T[] {
  const selected: T[] = [];
  let remaining = maxTokens;
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = messages[i]!;
    const tokens = estimateTokensForMessage(message);
    if (tokens <= remaining) {
      selected.push(message);
      remaining -= tokens;
    } else {
      selected.push(replaceMessageText(message, truncateTextToTokens(extractText(message.content ?? []), remaining)));
      break;
    }
  }
  selected.reverse();
  return selected;
}

export function selectCompactionUserMessages<
  T extends {
    role?: string;
    content?: readonly ContentPart[];
    toolCalls?: readonly { name: string; arguments: unknown }[];
    origin?: { kind?: string };
  },
>(
  messages: readonly T[],
  maxTokens: number = COMPACT_USER_MESSAGE_MAX_TOKENS,
  headTokens: number = 2_000,
): { head: T[]; tail: T[]; elided: boolean; omittedTokens: number } {
  let totalTokens = 0;
  for (const message of messages) {
    totalTokens += estimateTokensForMessage(message);
  }
  if (totalTokens <= maxTokens) {
    return { head: [], tail: [...messages], elided: false, omittedTokens: 0 };
  }

  const headBudget = Math.min(Math.max(headTokens, 0), maxTokens);
  const tailBudget = maxTokens - headBudget;
  const tail: T[] = [];
  let tailRemaining = tailBudget;
  let headEndExclusive = messages.length;
  let tailBoundaryDroppedPrefix: T | null = null;

  for (let i = messages.length - 1; i >= 0 && tailRemaining > 0; i--) {
    const message = messages[i]!;
    const tokens = estimateTokensForMessage(message);
    if (tokens <= tailRemaining) {
      tail.push(message);
      tailRemaining -= tokens;
      headEndExclusive = i;
    } else {
      const fullText = extractText(message.content ?? []);
      const keptSuffix = truncateTextToTokensFromEnd(fullText, tailRemaining);
      tail.push(replaceMessageText(message, keptSuffix));
      headEndExclusive = i;
      const droppedPrefix = fullText.slice(0, fullText.length - keptSuffix.length);
      if (droppedPrefix.length > 0) {
        tailBoundaryDroppedPrefix = replaceMessageText(message, droppedPrefix);
      }
      break;
    }
  }
  tail.reverse();

  const headCandidates = messages.slice(0, headEndExclusive);
  if (tailBoundaryDroppedPrefix !== null) {
    headCandidates.push(tailBoundaryDroppedPrefix);
  }
  const head: T[] = [];
  let headRemaining = headBudget;
  for (const message of headCandidates) {
    if (headRemaining <= 0) break;
    const tokens = estimateTokensForMessage(message);
    if (tokens <= headRemaining) {
      head.push(message);
      headRemaining -= tokens;
    } else {
      head.push(replaceMessageText(message, truncateTextToTokens(extractText(message.content ?? []), headRemaining)));
      break;
    }
  }

  let keptTokens = 0;
  for (const message of head) keptTokens += estimateTokensForMessage(message);
  for (const message of tail) keptTokens += estimateTokensForMessage(message);
  return {
    head,
    tail,
    elided: true,
    omittedTokens: Math.max(0, totalTokens - keptTokens),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Tool result renderer
// ════════════════════════════════════════════════════════════════════════════

export interface RenderableToolResult {
  readonly output: string | readonly ContentPart[];
  readonly note?: string | undefined;
  readonly isError?: boolean | undefined;
}

export function renderToolResultForModel(result: RenderableToolResult): ContentPart[] {
  const rendered = renderStatus(result);
  if (result.note === undefined || result.note.length === 0) return rendered;
  const only = rendered[0];
  if (rendered.length === 1 && only?.type === 'text') {
    return [{ type: 'text', text: `${only.text}\n${result.note}` }];
  }
  return [...rendered, { type: 'text', text: result.note }];
}

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

function renderStatus(result: RenderableToolResult): ContentPart[] {
  const output = result.output;
  const single = typeof output === 'string' ? output : singleTextPart(output);
  if (single !== undefined) {
    if (result.isError === true) {
      if (single.length === 0) return [{ type: 'text', text: TOOL_EMPTY_ERROR_STATUS }];
      return [{ type: 'text', text: `${TOOL_ERROR_STATUS}\n${single}` }];
    }
    return isEmptyOutputText(single)
      ? [{ type: 'text', text: TOOL_EMPTY_STATUS }]
      : [{ type: 'text', text: single }];
  }

  const parts = output as readonly ContentPart[];
  if (isEmptyEquivalentContentArray(parts)) {
    return [
      {
        type: 'text',
        text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS,
      },
    ];
  }
  if (result.isError === true) return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...parts];
  return [...parts];
}

function singleTextPart(output: readonly ContentPart[]): string | undefined {
  const first = output[0];
  return output.length === 1 && first?.type === 'text' ? first.text : undefined;
}

function isEmptyOutputText(output: string): boolean {
  return output.trim().length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}

function isEmptyEquivalentContentArray(output: readonly ContentPart[]): boolean {
  return output.every((part) => part.type === 'text' && part.text.trim().length === 0);
}

// ════════════════════════════════════════════════════════════════════════════
// Wire record migration (needed by wire-reader.ts)
// ════════════════════════════════════════════════════════════════════════════

export interface WireMigrationRecord {
  readonly type: string;
  [key: string]: unknown;
}

export interface WireMigration {
  readonly sourceVersion: string;
  readonly targetVersion: string;
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord;
}

function compareWireVersions(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const maxLength = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLength; i++) {
    const diff = Number(partsA[i] ?? '0') - Number(partsB[i] ?? '0');
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── Individual migrations ─────────────────────────────────────────────────
//
// v1.0 → v1.1: flatten nested `function` wrapper in tool calls.
const migrateV1_0ToV1_1: WireMigration = {
  sourceVersion: '1.0',
  targetVersion: '1.1',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    if (record.type !== 'context.append_message') return record;
    const msg = record['message'] as Record<string, unknown> | undefined;
    if (msg === undefined) return record;
    const toolCalls = msg['toolCalls'];
    if (!Array.isArray(toolCalls)) return record;
    return {
      ...record,
      message: {
        ...msg,
        toolCalls: toolCalls.map((tc: Record<string, unknown>) => {
          const fn = tc['function'] as Record<string, unknown> | undefined;
          if (fn === undefined) return tc;
          const { function: _fn, ...rest } = tc;
          return { ...rest, name: fn['name'], arguments: fn['arguments'] };
        }),
      },
    } as WireMigrationRecord;
  },
};

// v1.1 → v1.2: backfill `sessionApprovalRule` from legacy action labels.
const migrateV1_1ToV1_2: WireMigration = {
  sourceVersion: '1.1',
  targetVersion: '1.2',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    if (record.type !== 'permission.record_approval_result') return record;
    if (record['sessionApprovalRule'] !== undefined) return record;
    const result = record['result'] as Record<string, unknown> | undefined;
    if (result?.['decision'] !== 'approved' || result?.['scope'] !== 'session') return record;
    return record; // The rule is a nice-to-have; pass-through is safe.
  },
};

// v1.2 → v1.3: bump-only (blobref support, no record transformation).
const migrateV1_2ToV1_3: WireMigration = {
  sourceVersion: '1.2',
  targetVersion: '1.3',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};

// v1.3 → v1.4: goal record normalization.
const migrateV1_3ToV1_4: WireMigration = {
  sourceVersion: '1.3',
  targetVersion: '1.4',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    switch (record.type) {
      case 'goal.create':
        return {
          type: 'goal.create',
          goalId: record['goalId'],
          objective: record['objective'],
          completionCriterion: record['completionCriterion'],
          time: record['time'],
        } as WireMigrationRecord;
      case 'goal.update':
        return {
          type: 'goal.update',
          status: record['status'],
          reason: record['reason'],
          turnsUsed: record['turnsUsed'],
          tokensUsed: record['tokensUsed'],
          wallClockMs: record['wallClockMs'],
          actor: record['actor'],
          time: record['time'],
        } as WireMigrationRecord;
      case 'goal.account_usage':
        return {
          type: 'goal.update',
          tokensUsed: record['tokensUsed'],
          wallClockMs: record['wallClockMs'],
          time: record['time'],
        } as WireMigrationRecord;
      case 'goal.continuation':
        return {
          type: 'goal.update',
          turnsUsed: record['turnsUsed'],
          time: record['time'],
        } as WireMigrationRecord;
      case 'goal.clear':
        return { type: 'goal.clear', time: record['time'] } as WireMigrationRecord;
      default:
        return record;
    }
  },
};

const MIGRATIONS: readonly WireMigration[] = [
  migrateV1_0ToV1_1,
  migrateV1_1ToV1_2,
  migrateV1_2ToV1_3,
  migrateV1_3ToV1_4,
];

// ── Public migration API ──────────────────────────────────────────────────

export function isNewerWireVersion(readVersion: string): boolean {
  return compareWireVersions(readVersion, AGENT_WIRE_PROTOCOL_VERSION) > 0;
}

export function resolveWireMigrations(readVersion: string): readonly WireMigration[] {
  if (compareWireVersions(readVersion, AGENT_WIRE_PROTOCOL_VERSION) >= 0) {
    return [];
  }
  const migrations: WireMigration[] = [];
  let version = readVersion;
  while (compareWireVersions(version, AGENT_WIRE_PROTOCOL_VERSION) < 0) {
    const migration = MIGRATIONS.find((m) => m.sourceVersion === version);
    if (migration === undefined) {
      throw new Error(`Missing wire migration for version ${version}`);
    }
    migrations.push(migration);
    version = migration.targetVersion;
  }
  return migrations;
}

export function migrateWireRecord(
  record: WireMigrationRecord,
  migrations: readonly WireMigration[],
): WireMigrationRecord {
  return migrations.reduce((current, migration) => migration.migrateRecord(current), record);
}