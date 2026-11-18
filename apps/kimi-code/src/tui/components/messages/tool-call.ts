import { isAbsolute, relative, sep } from 'node:path';

import chalk from 'chalk';

import {
  Container,
  Spacer,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@moonshot-ai/pi-tui';
import type { Component, TUI } from '@moonshot-ai/pi-tui';
import { Markdown } from '#/tui/components/markdown/markdown';
import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';
import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  COMMAND_PREVIEW_LINES,
  DETACH_HINT_TEXT,
  FOREGROUND_BASH_HINT_DELAY_MS,
  MESSAGE_INDENT,
  OUTCOME_MAX_LINES,
  RESULT_PREVIEW_LINES,
  SUBAGENT_PREVIEW_TEXT_MAX_CHARS,
  THINKING_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import {
  STREAMING_ARGS_FIELD_RE,
  STREAMING_ARGS_PREVIEW_MAX_CHARS,
} from '#/tui/constant/streaming';
import {
  FAILURE_MARK,
  NOTIFY_USER_MARK,
  NOTIFY_USER_MARK_FOREGROUND,
  STATUS_BULLET,
  SUCCESS_MARK,
} from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import type { Elapsed, ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';
import { appendStreamingArgsPreview } from '#/tui/utils/event-payload';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';
import { notifyResultState } from '#/tui/utils/notify-result';
import { isExperimentalFlagEnabled } from '#/tui/commands/experimental-flags';
import { decodeMcpToolName } from '#/tui/utils/mcp-tool-name';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { formatTokenCount } from '#/utils/usage/usage-format';

import { agentSwarmResultSummaryFromOutput } from './agent-swarm-progress';
import { PlanBoxComponent } from './plan-box';
import {
  TruncatedHeaderLine,
  type HeaderContent,
  type HeaderSegments,
} from './truncated-header-line';
import { ShellExecutionComponent } from './shell-execution';
import { chipText, countNonEmptyLines } from './tool-renderers/chip';
import { buildGoalToolHeader, isGoalToolName, parseGoalToolOutput } from './tool-renderers/goal';
import { searchNoticeOnly } from './tool-renderers/grep-output';
import { parseReadMediaOutput } from './tool-renderers/media';
import { nonEmptyLines, outcomeLine, outcomeRows } from './tool-renderers/outcome';
import { TruncatedOutputComponent, trimTrailingEmptyLines } from './tool-renderers/truncated';
import { CardOnly, isSpilledToolOutput } from './tool-renderers/types';
import { isGenericToolResult, pickResultRenderer } from './tool-renderers/registry';
import {
  isTodoListRead,
  TodoCardBody,
  todoCardHidesItems,
  todoListFromResult,
} from './tool-renderers/todo';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';
import { buildWaitForHeader, parseWaitForOutput } from './tool-renderers/wait-for';

const MAX_ARG_LENGTH = 60;
const MAX_SUB_TOOL_CALLS_SHOWN = 4;
const MAX_SUBAGENT_DESCRIPTION_LENGTH = 60;
const APPROVED_PLAN_MARKER = '## Approved Plan:';
const AUTO_APPROVED_PLAN_MARKER = '## Plan (auto-approved, not user-reviewed):';
const STREAMING_PROGRESS_INTERVAL_MS = 1000;
const PROGRESS_URL_RE = /https?:\/\/\S+/g;
const ABORTED_MARK = '⊘';
const MAX_LIVE_OUTPUT_CHARS = 50_000;
const CARD_PREAMBLE_CHILDREN = 2;
const dimHeaderStyle = (text: string): string => currentTheme.dim(text);
const notifyTitleStyle = (text: string): string => currentTheme.boldFg('textStrong', text);

type SubagentTextKind = 'thinking' | 'text';
type SubagentPhase = 'queued' | 'spawning' | 'running' | 'done' | 'failed' | 'backgrounded';

interface FinishedSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly output: string;
  readonly isError: boolean;
}

interface OngoingSubCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly streamingArguments?: string | undefined;
}

interface SubToolActivity {
  readonly id: string;
  name: string;
  args: Record<string, unknown>;
  phase: 'ongoing' | 'done' | 'failed';
  output?: string;
  readonly orderSeq: number;
}

export interface ToolCallSubagentSnapshot {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolCallDescription: string;
  readonly agentName: string | undefined;
  readonly model?: string;
  readonly effort?: string;
  readonly phase: SubagentPhase | undefined;
  readonly toolCount: number;
  readonly elapsedSeconds: number | undefined;
  readonly tokens: number;
  readonly isError: boolean;
  readonly errorText: string | undefined;
  readonly latestActivity: string | undefined;
}

export interface ToolCallReadSnapshot {
  readonly toolCallId: string;
  readonly filePath: string | undefined;
  readonly phase: 'pending' | 'done' | 'failed';
  readonly lines: number;
}

function backgroundFailureMessage(
  status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost' | undefined,
): string | undefined {
  switch (status) {
    case 'lost':
      return 'Background agent lost (session restarted before completion)';
    case 'killed':
      return 'Background agent killed';
    case 'timed_out':
      return 'Background agent timed out';
    case 'failed':
      return 'Background agent failed';
    case 'completed':
    case undefined:
      return undefined;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function formatSubagentContextTokens(contextTokens: number | undefined): string | undefined {
  if (contextTokens === undefined || contextTokens <= 0) return undefined;
  return `${formatTokenCount(contextTokens)} tok`;
}

function usageInputTotal(usage: TokenUsage): number {
  return (usage.inputOther ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0);
}

function usageTotal(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usageInputTotal(usage) + usage.output;
}

function formatSubagentTokens(usage: TokenUsage | undefined): string | undefined {
  const total = usageTotal(usage);
  if (total <= 0) return undefined;
  return `${formatTokenCount(total)} tok`;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

function extractApprovedPlan(output: string): string {
  const marker = output.includes(AUTO_APPROVED_PLAN_MARKER)
    ? AUTO_APPROVED_PLAN_MARKER
    : APPROVED_PLAN_MARKER;
  const markerIndex = output.indexOf(marker);
  if (markerIndex < 0) return '';
  return output.slice(markerIndex + marker.length).trim();
}

interface ExitPlanModeOutcome {
  readonly kind: 'approved' | 'auto_approved' | 'rejected';
  readonly chosen?: string;
  readonly feedback?: string;
  readonly path?: string;
}

const REJECT_PREFIX = 'User rejected the plan.';
const REJECT_FEEDBACK_PREFIX = 'User rejected the plan. Feedback:';
const APPROVED_OPTION_RE = /^User approved option "([^"]+)"\./;
const PLAN_REJECT_PREFIX = 'Plan rejected by user.';
const SELECTED_APPROACH_RE = /^Exited plan mode\. Selected approach: ([^\n]+)\n/;
const PLAN_SAVED_TO_RE = /\nPlan saved to: ([^\n]+)\n/;

function interpretExitPlanModeOutcome(output: string): ExitPlanModeOutcome {
  if (output.startsWith(REJECT_PREFIX)) {
    if (output.startsWith(REJECT_FEEDBACK_PREFIX)) {
      const feedback = output.slice(REJECT_FEEDBACK_PREFIX.length).trimStart();
      return { kind: 'rejected', feedback };
    }
    return { kind: 'rejected' };
  }
  if (output.startsWith(PLAN_REJECT_PREFIX)) {
    return { kind: 'rejected' };
  }
  const pathMatch = PLAN_SAVED_TO_RE.exec(output);
  const path = pathMatch?.[1]?.trim();
  if (output.includes(AUTO_APPROVED_PLAN_MARKER)) {
    return path !== undefined && path.length > 0
      ? { kind: 'auto_approved', path }
      : { kind: 'auto_approved' };
  }
  const optionMatch = SELECTED_APPROACH_RE.exec(output) ?? APPROVED_OPTION_RE.exec(output);
  if (optionMatch !== null) {
    return path !== undefined && path.length > 0
      ? { kind: 'approved', chosen: optionMatch[1], path }
      : { kind: 'approved', chosen: optionMatch[1] };
  }
  return path !== undefined && path.length > 0 ? { kind: 'approved', path } : { kind: 'approved' };
}

function isExitPlanModeOutcomeOutput(output: string): boolean {
  return (
    output.startsWith(REJECT_PREFIX) ||
    output.startsWith(PLAN_REJECT_PREFIX) ||
    output.startsWith('Exited plan mode.') ||
    APPROVED_OPTION_RE.test(output) ||
    output.includes(APPROVED_PLAN_MARKER) ||
    output.includes(AUTO_APPROVED_PLAN_MARKER)
  );
}

function unescapeJsonString(s: string): string {
  return s.replaceAll(/\\(["\\/bfnrt])/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      default:
        return ch;
    }
  });
}

export function extractPartialStringField(text: string, key: string): string | undefined {
  const opener = new RegExp(`"${key}"\\s*:\\s*"`);
  const match = opener.exec(text);
  if (match === null) return undefined;
  const start = match.index + match[0].length;
  let out = '';
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) return out;
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'u': {
          if (i + 5 >= text.length) return out;
          const hex = text.slice(i + 2, i + 6);
          const code = Number.parseInt(hex, 16);
          if (Number.isNaN(code)) return out;
          out += String.fromCodePoint(code);
          i += 6;
          continue;
        }
        default:
          out += next;
      }
      i += 2;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
    i++;
  }
  return out;
}

function parseArgsPreview(value: string): Record<string, unknown> {
  const previewText = value.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
  if (previewText.trim().length === 0) return {};
  if (
    value.length <= STREAMING_ARGS_PREVIEW_MAX_CHARS &&
    previewText.trimEnd().endsWith('}')
  ) {
    try {
      const parsed = JSON.parse(previewText) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  const result: Record<string, unknown> = {};
  for (const match of previewText.matchAll(STREAMING_ARGS_FIELD_RE)) {
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    if (!(key in result)) result[key] = unescapeJsonString(rawValue);
  }
  return result;
}

const PATH_KEYS = new Set(['path', 'file_path']);

function truncateArgValue(key: string, value: string): string {
  if (value.length <= MAX_ARG_LENGTH) return value;
  if (PATH_KEYS.has(key)) {
    return '…' + value.slice(value.length - (MAX_ARG_LENGTH - 1));
  }
  return value.slice(0, MAX_ARG_LENGTH - 1) + '…';
}

function makeWorkspaceRelativePath(filePath: string, workspaceDir: string | undefined): string {
  if (workspaceDir === undefined || workspaceDir.length === 0 || !isAbsolute(filePath)) {
    return filePath;
  }
  const relativePath = relative(workspaceDir, filePath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return filePath;
  }
  return relativePath;
}

function displayKeyArgument(
  toolName: string,
  key: string,
  value: string,
  workspaceDir: string | undefined,
): string {
  return toolName === 'Read' && PATH_KEYS.has(key)
    ? makeWorkspaceRelativePath(value, workspaceDir)
    : value;
}

export interface KeyArgument {
  readonly text: string;
  readonly keep: 'head' | 'tail';
}

export function extractKeyArgument(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string | null {
  const detail = extractKeyArgumentDetail(toolName, args, workspaceDir);
  if (detail === null) return null;
  return truncateArgValue(detail.keep === 'tail' ? 'path' : 'value', detail.text);
}

export function extractKeyArgumentDetail(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): KeyArgument | null {
  const keyMap: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['path', 'file_path'],
    Write: ['path', 'file_path'],
    Edit: ['path', 'file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    FetchURL: ['url'],
    WebSearch: ['query'],
    Agent: ['description', 'prompt'],
    NotifyUser: ['title', 'message'],
  };

  if (toolName === 'Glob') {
    const pattern = args['pattern'];
    if (typeof pattern !== 'string' || pattern.length === 0) return null;
    let summary = pattern;
    const path = args['path'];
    if (typeof path === 'string' && path.length > 0) {
      summary += ` · ${makeWorkspaceRelativePath(path, workspaceDir)}`;
    }
    if (args['include_ignored'] === true) {
      summary += ' · include ignored';
    }
    return { text: summary, keep: 'head' };
  }

  const candidates = keyMap[toolName] ?? Object.keys(args);
  for (const key of candidates) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      const firstLine = val.split('\n')[0] ?? val;
      const displayValue =
        toolName === 'Bash' && val.includes('\n') ? `${firstLine}…` : firstLine;
      return {
        text: displayKeyArgument(toolName, key, displayValue, workspaceDir),
        keep: PATH_KEYS.has(key) ? 'tail' : 'head',
      };
    }
  }
  return null;
}

function formatSubagentLabel(agentName: string | undefined): string {
  const raw = agentName?.trim();
  if (raw === undefined || raw.length === 0) return 'SubAgent';
  const label = raw
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  if (/\bagent$/i.test(label)) return label;
  return `${label} Agent`;
}

function tailNonEmptyLines(text: string, maxLines: number): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let end = text.length;
  while (end > 0 && lines.length < maxLines) {
    const start = text.lastIndexOf('\n', end - 1);
    const line = text.slice(start + 1, end).trimEnd();
    if (line.trim().length > 0) lines.push(line);
    end = start === -1 ? 0 : start;
  }
  return lines.toReversed();
}

function tailSourceLines(text: string, maxLines: number): string {
  let end = text.length;
  for (let seen = 0; seen < maxLines; seen++) {
    if (end === 0) return text;
    const start = text.lastIndexOf('\n', end - 1);
    if (start === -1) return text;
    end = start;
  }
  return text.slice(end + 1);
}

function tailPreviewText(text: string): string {
  if (text.length <= SUBAGENT_PREVIEW_TEXT_MAX_CHARS) return text;
  const tail = text.slice(text.length - SUBAGENT_PREVIEW_TEXT_MAX_CHARS);
  const lineBreak = tail.indexOf('\n');
  if (lineBreak !== -1) {
    const aligned = tail.slice(lineBreak + 1);
    if (tailNonEmptyLines(aligned, 2).length === 2) {
      return stripTerminalSequences(aligned);
    }
  }
  return stripTerminalSequences(tail);
}

function lastNonEmptyLine(text: string): string | undefined {
  let end = text.length;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1);
    const trimmed = text.slice(start + 1, end).trim();
    if (trimmed.length > 0) return trimmed;
    end = start === -1 ? 0 : start;
  }
  return undefined;
}

class PrefixedWrappedLine implements Component {
  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(
    private readonly firstPrefix: string,
    private readonly continuationPrefix: string,
    private readonly text: string,
    private readonly tailLines?: number,
    private readonly minLines?: number,
  ) { }

  invalidate(): void {
    this.renderCache = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    if (isRenderCacheEnabled() && this.renderCache?.width === safeWidth) {
      return this.renderCache.lines;
    }

    const prefixWidth = Math.max(
      visibleWidth(this.firstPrefix),
      visibleWidth(this.continuationPrefix),
    );
    const contentWidth = Math.max(1, safeWidth - prefixWidth);
    const wrapped = new Text(this.text, 0, 0).render(contentWidth);
    const lines =
      this.tailLines !== undefined && wrapped.length > this.tailLines
        ? wrapped.slice(wrapped.length - this.tailLines)
        : wrapped;
    if (this.minLines !== undefined) {
      while (lines.length < this.minLines) lines.push('');
    }
    const rendered = lines
      .map((line, index) =>
        index === 0 ? `${this.firstPrefix}${line}` : `${this.continuationPrefix}${line}`,
      )
      .map((line) => truncateToWidth(line, safeWidth, '…'));
    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, lines: rendered };
    }
    return rendered;
  }
}

interface NotifyUserHeaderContent extends HeaderSegments {
  readonly notifyUserTitle: string;
}

function isNotifyUserHeaderContent(content: HeaderContent): content is NotifyUserHeaderContent {
  return typeof content !== 'string' && 'notifyUserTitle' in content;
}

function notifyUserPrefix(fullscreen: boolean): string {
  if (fullscreen) return currentTheme.fg('primary', STATUS_BULLET);
  return `${currentTheme.bg(
    'primary',
    chalk.hex(NOTIFY_USER_MARK_FOREGROUND)(NOTIFY_USER_MARK),
  )} `;
}

function notifyUserLiveArgs(toolCall: ToolCallBlockData): Record<string, unknown> {
  const stream = toolCall.streamingArguments;
  if (stream === undefined) return toolCall.args;
  return {
    ...toolCall.args,
    title: extractPartialStringField(stream, 'title') ?? toolCall.args['title'],
    message: extractPartialStringField(stream, 'message') ?? toolCall.args['message'],
  };
}

function notifyUserTitle(args: Record<string, unknown>): string {
  const title = stripTerminalSequences(str(args['title']))
    .replaceAll(/[\r\n]+/g, ' ')
    .trim();
  if (title.length > 0) return title;
  const firstLine = str(args['message'])
    .split(/\r\n|\r|\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (firstLine === undefined) return '';
  return stripTerminalSequences(firstLine)
    .replace(/^[-*#>\s]+/, '')
    .replaceAll('**', '')
    .trim();
}

class NotifyUserHeader extends TruncatedHeaderLine {
  private prefix = '';
  private title: string | undefined;
  private expanded = false;
  private expandedCache: { width: number; lines: string[] } | undefined;

  constructor(content: HeaderContent) {
    super(content);
    this.setText(content);
  }

  override setText(content: HeaderContent): void {
    if (isNotifyUserHeaderContent(content)) {
      this.prefix = content.head;
      this.title = content.notifyUserTitle;
    } else {
      this.prefix = '';
      this.title = undefined;
    }
    this.expandedCache = undefined;
    super.setText(content);
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.invalidate();
  }

  override invalidate(): void {
    this.expandedCache = undefined;
    super.invalidate();
  }

  override render(width: number): string[] {
    if (this.title === undefined || !this.expanded) return super.render(width);
    const safeWidth = Math.max(1, width);
    if (isRenderCacheEnabled() && this.expandedCache?.width === safeWidth) {
      return this.expandedCache.lines;
    }
    const firstPrefix = this.prefix;
    const firstWidth = Math.max(1, safeWidth - visibleWidth(firstPrefix));
    const continuationWidth = Math.max(1, safeWidth - visibleWidth(MESSAGE_INDENT));
    const first = wrapTextWithAnsi(this.title, firstWidth)[0] ?? '';
    const remainder = this.title.slice(first.length).trimStart();
    const continuation =
      remainder.length > 0 ? wrapTextWithAnsi(remainder, continuationWidth) : [];
    const lines = [first, ...continuation].map((row, index) =>
      truncateToWidth(
        `${index === 0 ? firstPrefix : MESSAGE_INDENT}${notifyTitleStyle(row)}`,
        safeWidth,
        '…',
      ),
    );
    if (isRenderCacheEnabled()) this.expandedCache = { width: safeWidth, lines };
    return lines;
  }
}

function stripTerminalSequencesExceptLinks(text: string): string {
  return text
    .split(/(\u001B\]8;[^;]*;[^\u0007\u001B]*(?:\u0007|\u001B\\))/g)
    .map((part) => (part.startsWith('\u001B]8;') ? part : stripTerminalSequences(part)))
    .join('');
}

class ToolOutputMarkdown extends Markdown {
  private dimCache: { source: string[]; lines: string[] } | undefined;

  override invalidate(): void {
    this.dimCache = undefined;
    super.invalidate();
  }

  override render(width: number): string[] {
    const source = super.render(width);
    if (isRenderCacheEnabled() && this.dimCache?.source === source) return this.dimCache.lines;
    const lines = source.map((line) =>
      currentTheme.dim(
        truncateToWidth(stripTerminalSequencesExceptLinks(line).trimEnd(), Math.max(1, width), '…'),
      ),
    );
    if (isRenderCacheEnabled()) this.dimCache = { source, lines };
    return lines;
  }
}

class StableSpacer extends Spacer {
  private cache: { width: number; lines: string[] } | undefined;

  override render(width: number): string[] {
    if (!isRenderCacheEnabled()) return super.render(width);
    if (this.cache?.width !== width) this.cache = { width, lines: super.render(width) };
    return this.cache.lines;
  }
}

export class ToolCallComponent extends Container {
  private expanded = false;
  private toolCall: ToolCallBlockData;
  private readonly markdownTheme = createMarkdownTheme();
  private hiddenContent: boolean | undefined = undefined;
  private truncatedAtLastRender = false;
  readonly startedAtMs = Date.now();

  private result: ToolResultBlockData | undefined;
  private elapsed: Elapsed | undefined;
  private projectionVersion = 0;
  private ui: TUI | undefined;
  private planPath: string | undefined;
  private currentPlan: string | undefined;
  private headerText: TruncatedHeaderLine;
  private callPreviewEndIndex = 0;

  private subagentAgentId: string | undefined;
  private subagentAgentName: string | undefined;
  private readonly ongoingSubCalls = new Map<string, OngoingSubCall>();
  private readonly finishedSubCalls: FinishedSubCall[] = [];
  private readonly subToolActivities = new Map<string, SubToolActivity>();
  private subToolOrderSeq = 0;
  private hiddenSubCallCount = 0;
  private subagentText = '';
  private subagentThinkingText = '';
  private lastSubagentStreamKind: SubagentTextKind = 'text';
  private subagentPhase: SubagentPhase | undefined;
  private detachedFromForeground = false;
  private backgroundTaskTerminalPhase: 'done' | 'failed' | undefined;
  private subagentContextTokens: number | undefined;
  private subagentUsage: TokenUsage | undefined;
  private subagentModel: string | undefined;
  private subagentEffort: string | undefined;
  private subagentResultSummary: string | undefined;
  private subagentError: string | undefined;
  private streamingProgressTimer: ReturnType<typeof setInterval> | undefined;
  private subagentElapsedTimer: ReturnType<typeof setInterval> | undefined;
  private subagentStartedAtMs: number | undefined;
  private subagentEndedAtMs: number | undefined;
  private subagentSpinnerFrame = 0;

  private progressLines: string[] = [];
  private progressStatusRows = 0;
  private static readonly MAX_PROGRESS_LINES = 24;
  private liveOutput = '';

  private detachHintTimer: ReturnType<typeof setTimeout> | undefined;
  private detachHintVisible = false;

  private onSnapshotChange: (() => void) | undefined;

  constructor(
    toolCall: ToolCallBlockData,
    result: ToolResultBlockData | undefined,
    ui?: TUI,
    private readonly workspaceDir?: string,
  ) {
    super();
    this.toolCall = toolCall;
    this.result = result;
    this.elapsed = result === undefined ? undefined : { known: false };
    this.ui = ui;
    this.applySubagentReplay(toolCall.subagent);

    this.addChild(new StableSpacer(1));
    this.headerText =
      toolCall.name === 'NotifyUser'
        ? new NotifyUserHeader(this.buildHeader())
        : new TruncatedHeaderLine(this.buildHeader());
    this.addChild(this.headerText);
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildProgressBlock();
    this.buildLiveOutputBlock();
    this.buildContent();
    this.buildSubagentBlock();
    this.syncStreamingProgressTimer();
    this.syncSubagentElapsedTimer();
    this.startDetachHintTimer();
  }

  private renderCache:
    | { width: number; lines: string[]; childRefs: Component[]; childLines: string[][] }
    | undefined;

  override render(width: number): string[] {
    const cache = this.renderCache;
    const cacheValid =
      isRenderCacheEnabled() &&
      cache !== undefined &&
      cache.width === width &&
      cache.childRefs.length === this.children.length;

    const childRefs: Component[] = [];
    const childLines: string[][] = [];
    let allReused = cacheValid;

    let i = 0;
    for (const child of this.children) {
      const lines = child.render(width);
      childRefs.push(child);
      childLines.push(lines);
      if (cacheValid && (cache.childRefs[i] !== child || cache.childLines[i] !== lines)) {
        allReused = false;
      }
      i++;
    }

    if (!this.expanded) {
      this.truncatedAtLastRender = this.children.some(
        (child, index) =>
          (child instanceof TruncatedHeaderLine &&
            (index !== 1 ||
              (this.toolCall.name === 'Bash' && this.toolCall.truncated !== true)) &&
            child.wasTruncated()) ||
          ((child instanceof TruncatedOutputComponent || child instanceof ShellExecutionComponent) &&
            child.wasTruncated()),
      );
    } else if (
      !this.truncatedAtLastRender &&
      this.collapsedOutcomeClips(width)
    ) {
      this.truncatedAtLastRender = true;
    }

    if (allReused) {
      return cache!.lines;
    }

    const out: string[] = [];
    for (const lines of childLines) {
      for (const line of lines) out.push(line);
    }
    if (isRenderCacheEnabled()) {
      this.renderCache = { width, lines: out, childRefs, childLines };
    }
    return out;
  }

  private rowDetailCache:
    | { width: number; lines: string[]; parts: Component[]; partLines: string[][] }
    | undefined;

  renderRowDetail(width: number): string[] {
    const parts = this.children.slice(CARD_PREAMBLE_CHILDREN).filter((child) => !(child instanceof CardOnly));
    const partLines = parts.map((part) => part.render(width));
    const cache = this.rowDetailCache;
    if (
      isRenderCacheEnabled() &&
      cache !== undefined &&
      cache.width === width &&
      cache.parts.length === parts.length &&
      parts.every((part, index) => cache.parts[index] === part && cache.partLines[index] === partLines[index])
    ) {
      return cache.lines;
    }
    const lines = partLines.flat();
    this.rowDetailCache = { width, lines, parts, partLines };
    return lines;
  }

  statusMarker(): string {
    const { toolCall, result } = this;
    if (result === undefined) {
      if (toolCall.truncated === true) return currentTheme.fg('error', FAILURE_MARK);
      return currentTheme.fg('text', STATUS_BULLET);
    }
    if (result.is_error === true) return currentTheme.fg('error', FAILURE_MARK);
    if (isGoalToolName(toolCall.name)) return currentTheme.fg('primary', STATUS_BULLET);
    if (toolCall.name === 'WaitFor' && parseWaitForOutput(result.output)?.status === 'timed_out') {
      return currentTheme.fg('warning', STATUS_BULLET);
    }
    return currentTheme.fg('success', STATUS_BULLET);
  }

  override invalidate(): void {
    this.renderCache = undefined;
    this.rowDetailCache = undefined;
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    super.invalidate();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    if (this.headerText instanceof NotifyUserHeader) this.headerText.setExpanded(expanded);
    this.rebuildBody();
  }

  hasHiddenContent(): boolean {
    this.hiddenContent ??= this.computeHiddenContent();
    return this.hiddenContent || this.truncatedAtLastRender;
  }

  private collapsedOutcomeClipCache: { width: number; clips: boolean } | undefined;

  private collapsedOutcomeClips(width: number): boolean {
    const cacheEnabled = isRenderCacheEnabled();
    if (cacheEnabled && this.collapsedOutcomeClipCache?.width === width) {
      return this.collapsedOutcomeClipCache.clips;
    }
    const result = this.result;
    if (result === undefined || result.output.length === 0 || result.is_error === true) {
      return false;
    }
    const name = this.toolCall.name;
    if (name !== 'Bash' && !isGenericToolResult(name)) return false;
    const leadsWithMetadata =
      name === 'Bash' &&
      (result.output.startsWith('task_id:') || isSpilledToolOutput(result.output));
    const rows = outcomeRows(
      result.output,
      name === 'Bash' && !leadsWithMetadata ? 'last' : 'first',
    );
    let clips = false;
    for (const row of rows) {
      if (!(row instanceof TruncatedHeaderLine)) continue;
      row.render(width);
      if (row.wasTruncated()) clips = true;
    }
    if (cacheEnabled) this.collapsedOutcomeClipCache = { width, clips };
    return clips;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  private computeHiddenContent(): boolean {
    const { name, args } = this.toolCall;
    if (this.isSingleSubagentView()) return false;
    if (this.toolCall.truncated === true && this.result === undefined) return false;
    if (
      name === 'NotifyUser' &&
      isExperimentalFlagEnabled('notify_user') &&
      this.result === undefined
    ) {
      return str(notifyUserLiveArgs(this.toolCall)['message']).trim().length > 0;
    }
    if (this.result === undefined && this.toolCall.streamingArguments !== undefined) {
      return (
        name === 'Bash' &&
        (extractPartialStringField(this.toolCall.streamingArguments, 'command') ?? '').length > 0
      );
    }
    if (this.callPreviewHidesContent()) return true;
    const { result } = this;
    if (result === undefined) return nonEmptyLines(this.liveOutput).length > 1;
    if (result.output.length === 0) return false;
    if (result.output.trimStart().startsWith('<system-reminder>')) return false;
    if (result.is_error === true) {
      const output = name === 'Bash' ? sanitizeShellOutput(result.output) : result.output;
      return trimTrailingEmptyLines(output.split('\n')).length > RESULT_PREVIEW_LINES + 1;
    }
    switch (name) {
      case 'ReadMediaFile':
        return (
          parseReadMediaOutput(result.output) !== null ||
          nonEmptyLines(result.output).length > OUTCOME_MAX_LINES
        );
      case 'Grep':
      case 'Glob':
        return (
          !searchNoticeOnly(this.toolCall, result.output) ||
          nonEmptyLines(result.output).length > OUTCOME_MAX_LINES
        );
      case 'WaitFor':
        return (
          parseWaitForOutput(result.output) !== undefined ||
          nonEmptyLines(result.output).length > OUTCOME_MAX_LINES
        );
      case 'Read':
      case 'FetchURL':
      case 'WebSearch':
      case 'Think':
        return true;
      case 'ExitPlanMode':
        return (
          !isExitPlanModeOutcomeOutput(result.output) &&
          nonEmptyLines(result.output).length > OUTCOME_MAX_LINES
        );
      case 'AskUserQuestion':
        return (
          args['background'] === true && nonEmptyLines(result.output).length > OUTCOME_MAX_LINES
        );
      case 'CreateGoal':
      case 'GetGoal':
        return (
          parseGoalToolOutput(result.output) === undefined &&
          nonEmptyLines(result.output).length > OUTCOME_MAX_LINES
        );
      case 'Edit':
      case 'Write':
        return false;
      case 'TodoList':
        return todoCardHidesItems(todoListFromResult(result.output));
      case 'SetGoalBudget':
      case 'UpdateGoal':
      case 'AgentSwarm':
      case 'EnterPlanMode':
        return false;
      default:
        return nonEmptyLines(result.output).length > OUTCOME_MAX_LINES;
    }
  }

  private callPreviewHidesContent(): boolean {
    const { name, args } = this.toolCall;
    switch (name) {
      case 'NotifyUser':
        return isExperimentalFlagEnabled('notify_user') && str(args['message']).trim().length > 0;
      case 'Bash':
        return str(args['command']).includes('\n');
      case 'Edit': {
        const oldStr = str(args['old_string']);
        const newStr = str(args['new_string']);
        if (oldStr.length === 0 && newStr.length === 0) return false;
        const filePath = str(args['file_path'] ?? args['path']);
        const full = renderDiffLinesClustered(oldStr, newStr, filePath, { contextLines: 3 });
        const capped = renderDiffLinesClustered(oldStr, newStr, filePath, {
          contextLines: 3,
          maxLines: COMMAND_PREVIEW_LINES,
        });
        return capped.length !== full.length || capped.at(-1) !== full.at(-1);
      }
      case 'Write': {
        const content = str(args['content']);
        const filePath = str(args['file_path'] ?? args['path']);
        return highlightLines(content, langFromPath(filePath)).length > COMMAND_PREVIEW_LINES + 1;
      }
      default:
        return false;
    }
  }

  setResult(result: ToolResultBlockData, elapsed: Elapsed): void {
    this.result = result;
    this.elapsed = elapsed;
    this.projectionVersion += 1;
    this.progressLines = [];
    this.progressStatusRows = 0;
    this.liveOutput = '';
    this.detachHintVisible = false;
    this.stopDetachHintTimer();
    this.finalizeSubagentElapsedIfNeeded();
    this.syncStreamingProgressTimer();
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    this.notifySnapshotChange();
  }

  updateToolCall(toolCall: ToolCallBlockData): void {
    this.projectionVersion += 1;
    this.toolCall = toolCall;
    this.syncStreamingProgressTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendProgress(text: string, options?: { readonly replace?: boolean }): void {
    if (this.result !== undefined) return;
    if (options?.replace === true && this.progressStatusRows > 0) {
      this.progressLines.splice(
        Math.max(0, this.progressLines.length - this.progressStatusRows),
        this.progressStatusRows,
      );
    }
    const lines = text.split('\n');
    for (const line of lines) {
      this.progressLines.push(line);
    }
    this.progressStatusRows = options?.replace === true ? lines.length : 0;
    while (this.progressLines.length > ToolCallComponent.MAX_PROGRESS_LINES) {
      this.progressLines.shift();
    }
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendLiveOutput(text: string): void {
    if (this.result !== undefined || text.length === 0) return;
    this.liveOutput += text;
    this.hiddenContent = undefined;
    if (this.liveOutput.length > MAX_LIVE_OUTPUT_CHARS) {
      this.liveOutput = `[…truncated]\n${this.liveOutput.slice(
        this.liveOutput.length - MAX_LIVE_OUTPUT_CHARS,
      )}`;
    }
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  dispose(): void {
    this.stopStreamingProgressTimer();
    this.stopSubagentElapsedTimer();
    this.stopDetachHintTimer();
  }

  setPlanInfo(info: { plan?: string; path?: string }): void {
    if (this.toolCall.name !== 'ExitPlanMode') return;
    let changed = false;
    if (info.plan !== undefined && info.plan.length > 0 && this.currentPlan !== info.plan) {
      this.currentPlan = info.plan;
      changed = true;
    }
    if (info.path !== undefined && info.path.length > 0 && this.planPath !== info.path) {
      this.planPath = info.path;
      changed = true;
    }
    if (!changed) return;
    this.rebuildBody();
    this.ui?.requestRender();
  }

  private applySubagentReplay(subagent: ToolCallBlockData['subagent']): void {
    if (subagent === undefined) return;
    this.subagentAgentId = subagent.id;
    this.subagentAgentName = subagent.name;
    this.subagentText = tailPreviewText(subagent.text ?? '');
    for (const call of subagent.toolCalls ?? []) {
      if (call.result === undefined) {
        this.ongoingSubCalls.set(call.id, { name: call.name, args: call.args });
        this.upsertSubToolActivity(call.id, call.name, call.args, 'ongoing');
        continue;
      }
      this.finishedSubCalls.push({
        name: call.name,
        args: call.args,
        output: call.result.output,
        isError: call.result.is_error ?? false,
      });
      this.upsertSubToolActivity(
        call.id,
        call.name,
        call.args,
        call.result.is_error === true ? 'failed' : 'done',
        call.result.output,
      );
    }
    while (this.finishedSubCalls.length > MAX_SUB_TOOL_CALLS_SHOWN) {
      this.finishedSubCalls.shift();
      this.hiddenSubCallCount += 1;
    }
  }

  setSubagentMeta(agentId: string, agentName?: string): void {
    if (this.subagentAgentId === agentId && this.subagentAgentName === agentName) return;
    this.subagentAgentId = agentId;
    this.subagentAgentName = agentName;
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  setSnapshotListener(cb: (() => void) | undefined): void {
    this.onSnapshotChange = cb;
    if (cb !== undefined) cb();
  }

  getSubagentSnapshot(): ToolCallSubagentSnapshot {
    const finished = this.finishedSubCalls.length + this.hiddenSubCallCount;
    const contextTokens = this.subagentContextTokens;
    const tokens =
      contextTokens && contextTokens > 0
        ? contextTokens
        : (this.subagentUsage === undefined ? 0 : usageTotal(this.subagentUsage));
    const latestActivity = computeLatestActivity(
      this.ongoingSubCalls,
      this.finishedSubCalls,
      this.getCombinedSubagentText(),
      this.workspaceDir,
    );
    const derivedPhase = this.getDerivedSubagentPhase();
    const errorText =
      this.subagentError ?? (derivedPhase === 'failed' ? this.result?.output : undefined);
    return {
      toolCallId: this.toolCall.id,
      toolName: this.toolCall.name,
      toolCallDescription: str(this.toolCall.args['description']) || str(this.toolCall.description),
      agentName: this.subagentAgentName,
      model: this.subagentModel,
      effort: this.subagentEffort,
      phase: derivedPhase,
      toolCount: finished,
      elapsedSeconds: this.getSubagentElapsedSeconds(),
      tokens,
      isError: derivedPhase === 'failed',
      errorText,
      latestActivity,
    };
  }

  getReadSnapshot(): ToolCallReadSnapshot {
    const args = this.toolCall.args;
    const filePathRaw = args['file_path'] ?? args['path'];
    const filePath =
      typeof filePathRaw === 'string'
        ? makeWorkspaceRelativePath(filePathRaw, this.workspaceDir)
        : undefined;
    if (this.result === undefined) {
      return { toolCallId: this.toolCall.id, filePath, phase: 'pending', lines: 0 };
    }
    if (this.result.is_error === true) {
      return { toolCallId: this.toolCall.id, filePath, phase: 'failed', lines: 0 };
    }
    return {
      toolCallId: this.toolCall.id,
      filePath,
      phase: 'done',
      lines: countNonEmptyLines(this.result.output),
    };
  }

  get toolCallView(): Readonly<ToolCallBlockData> {
    return this.toolCall;
  }

  get toolResultView(): Readonly<ToolResultBlockData> | undefined {
    return this.result;
  }

  get toolElapsed(): Elapsed | undefined {
    return this.elapsed;
  }

  get transcriptProjectionVersion(): number {
    return this.projectionVersion;
  }

  private notifySnapshotChange(): void {
    this.onSnapshotChange?.();
  }

  private upsertSubToolActivity(
    id: string,
    name: string,
    args: Record<string, unknown>,
    phase: SubToolActivity['phase'],
    output?: string,
  ): void {
    const existing = this.subToolActivities.get(id);
    if (existing !== undefined) {
      existing.name = name;
      existing.args = args;
      existing.phase = phase;
      if (output !== undefined) existing.output = output;
      return;
    }
    this.subToolActivities.set(id, {
      id,
      name,
      args,
      phase,
      ...(output !== undefined ? { output } : {}),
      orderSeq: ++this.subToolOrderSeq,
    });
  }

  private getCombinedSubagentText(): string {
    return [this.subagentThinkingText, this.subagentText].filter((s) => s.length > 0).join('\n');
  }

  private isStreamingEditPreview(): boolean {
    return (
      this.toolCall.name === 'Edit' &&
      this.result === undefined &&
      this.toolCall.streamingArguments !== undefined
    );
  }

  private syncStreamingProgressTimer(): void {
    if (!this.isStreamingEditPreview()) {
      this.stopStreamingProgressTimer();
      return;
    }
    if (this.ui === undefined || this.streamingProgressTimer !== undefined) return;
    this.streamingProgressTimer = setInterval(() => {
      if (!this.isStreamingEditPreview()) {
        this.stopStreamingProgressTimer();
        return;
      }
      this.rebuildBody();
      this.ui?.requestRender();
    }, STREAMING_PROGRESS_INTERVAL_MS);
  }

  private stopStreamingProgressTimer(): void {
    if (this.streamingProgressTimer === undefined) return;
    clearInterval(this.streamingProgressTimer);
    this.streamingProgressTimer = undefined;
  }

  private isDetachHintEligible(): boolean {
    return this.toolCall.name === 'Bash' || this.toolCall.name === 'Agent';
  }

  private startDetachHintTimer(): void {
    if (!this.isDetachHintEligible()) return;
    if (this.result !== undefined) return;
    if (this.ui === undefined) return;
    if (this.toolCall.name === 'Agent') {
      if (this.detachHintVisible) return;
      this.detachHintVisible = true;
      this.rebuildBody();
      this.ui?.requestRender();
      return;
    }
    if (this.detachHintTimer !== undefined) return;
    this.detachHintTimer = setTimeout(() => {
      this.detachHintTimer = undefined;
      if (this.result !== undefined) return;
      this.detachHintVisible = true;
      this.rebuildBody();
      this.ui?.requestRender();
    }, FOREGROUND_BASH_HINT_DELAY_MS);
  }

  private stopDetachHintTimer(): void {
    if (this.detachHintTimer === undefined) return;
    clearTimeout(this.detachHintTimer);
    this.detachHintTimer = undefined;
  }

  private buildDetachHintBlock(): void {
    if (!this.detachHintVisible) return;
    if (this.result !== undefined) return;
    this.addChild(new CardOnly(new Text(currentTheme.dim(DETACH_HINT_TEXT), 2, 0)));
  }

  private syncSubagentElapsedTimer(): void {
    const phase = this.getDerivedSubagentPhase();
    const shouldTick =
      this.isSingleSubagentView() &&
      this.subagentStartedAtMs !== undefined &&
      (phase === 'queued' || phase === 'spawning' || phase === 'running');
    if (!shouldTick) {
      this.stopSubagentElapsedTimer();
      return;
    }
    if (this.ui === undefined || this.subagentElapsedTimer !== undefined) return;
    this.subagentElapsedTimer = setInterval(() => {
      const latestPhase = this.getDerivedSubagentPhase();
      if (latestPhase !== 'queued' && latestPhase !== 'spawning' && latestPhase !== 'running') {
        this.stopSubagentElapsedTimer();
        return;
      }
      this.subagentSpinnerFrame = (this.subagentSpinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.headerText.setText(this.buildHeader());
      this.notifySnapshotChange();
      this.ui?.requestRender();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  private stopSubagentElapsedTimer(): void {
    if (this.subagentElapsedTimer === undefined) return;
    clearInterval(this.subagentElapsedTimer);
    this.subagentElapsedTimer = undefined;
  }

  private finalizeSubagentElapsedIfNeeded(): void {
    if (
      this.toolCall.name === 'Agent' &&
      this.subagentStartedAtMs !== undefined &&
      this.subagentEndedAtMs === undefined
    ) {
      this.subagentEndedAtMs = Date.now();
    }
  }

  onSubagentSpawned(meta: {
    agentId: string;
    agentName?: string | undefined;
    runInBackground: boolean;
  }): void {
    this.subagentAgentId = meta.agentId;
    this.subagentAgentName = meta.agentName;
    this.subagentPhase = meta.runInBackground ? 'backgrounded' : 'queued';
    this.projectionVersion += 1;
    this.subagentStartedAtMs = Date.now();
    this.subagentEndedAtMs = undefined;
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  onSubagentStarted(meta: {
    agentId: string;
    agentName?: string | undefined;
    runInBackground: boolean;
  }): void {
    this.subagentAgentId = meta.agentId;
    this.subagentAgentName = meta.agentName;
    if (
      !meta.runInBackground &&
      (this.subagentPhase === undefined || this.subagentPhase === 'queued')
    ) {
      this.subagentPhase = 'running';
    }
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  onSubagentCompleted(payload: {
    contextTokens?: number | undefined;
    usage?: TokenUsage | undefined;
    resultSummary: string;
  }): void {
    this.subagentPhase = 'done';
    this.projectionVersion += 1;
    this.subagentEndedAtMs ??= Date.now();
    if (payload.contextTokens !== undefined && payload.contextTokens > 0) {
      this.subagentContextTokens = payload.contextTokens;
    }
    this.subagentUsage = payload.usage;
    this.subagentResultSummary =
      payload.resultSummary.length > 0 ? payload.resultSummary : undefined;
    if (this.subagentText.trim().length === 0 && this.subagentResultSummary !== undefined) {
      this.subagentText = tailPreviewText(this.subagentResultSummary);
    }
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  updateSubagentMetrics(payload: {
    contextTokens?: number | undefined;
    usage?: TokenUsage | undefined;
    modelDisplay?: string | undefined;
    effortDisplay?: string | undefined;
  }): void {
    if (payload.contextTokens !== undefined && payload.contextTokens > 0) {
      this.subagentContextTokens = payload.contextTokens;
    }
    if (payload.usage !== undefined) {
      this.subagentUsage = payload.usage;
    }
    if (payload.modelDisplay !== undefined) {
      this.subagentModel = payload.modelDisplay;
    }
    if (payload.effortDisplay !== undefined) {
      this.subagentEffort = payload.effortDisplay;
    }
    this.headerText.setText(this.buildHeader());
    this.invalidate();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  onSubagentFailed(payload: { error: string }): void {
    this.subagentPhase = 'failed';
    this.projectionVersion += 1;
    this.subagentEndedAtMs ??= Date.now();
    this.subagentError = payload.error;
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  setBackgroundTaskTerminalStatus(
    status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost',
    options: { errorText?: string | undefined } = {},
  ): void {
    const phase: 'done' | 'failed' = status === 'completed' ? 'done' : 'failed';
    const { errorText } = options;
    const phaseUnchanged = this.backgroundTaskTerminalPhase === phase;
    let errorChanged = false;
    if (phase === 'failed') {
      if (errorText !== undefined && this.subagentError !== errorText) {
        this.subagentError = errorText;
        errorChanged = true;
      } else if (this.subagentError === undefined) {
        const generic = backgroundFailureMessage(status);
        if (generic !== undefined) {
          this.subagentError = generic;
          errorChanged = true;
        }
      }
    }
    if (phaseUnchanged && !errorChanged) return;
    this.backgroundTaskTerminalPhase = phase;
    this.projectionVersion += 1;
    this.subagentEndedAtMs ??= Date.now();
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
  }

  markBackgrounded(): void {
    if (this.detachedFromForeground) return;
    this.detachedFromForeground = true;
    this.subagentPhase = 'backgrounded';
    this.projectionVersion += 1;
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  getSubagentAgentId(): string | undefined {
    if (this.subagentAgentId !== undefined) return this.subagentAgentId;
    if (this.toolCall.name !== 'Agent' || this.result === undefined) return undefined;
    const match = this.result.output.match(/^agent_id:\s*(agent-[A-Za-z0-9_-]+)/m);
    return match?.[1];
  }

  getAgentToolDescription(): string | undefined {
    if (this.toolCall.name !== 'Agent') return undefined;
    const desc = this.toolCall.args['description'];
    return typeof desc === 'string' ? desc : undefined;
  }

  appendSubagentText(text: string, kind: SubagentTextKind = 'text'): void {
    this.lastSubagentStreamKind = kind;
    if (kind === 'thinking') {
      this.subagentThinkingText = tailPreviewText(this.subagentThinkingText + text);
    } else {
      this.subagentText = tailPreviewText(this.subagentText + text);
    }
    if (
      this.subagentPhase === undefined ||
      this.subagentPhase === 'queued' ||
      this.subagentPhase === 'spawning'
    ) {
      this.subagentPhase = 'running';
    }
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendSubToolCall(call: { id: string; name: string; args: Record<string, unknown> }): void {
    const existing = this.ongoingSubCalls.get(call.id);
    this.ongoingSubCalls.set(call.id, {
      name: call.name,
      args: call.args,
      ...(existing?.streamingArguments !== undefined
        ? { streamingArguments: existing.streamingArguments }
        : {}),
    });
    this.upsertSubToolActivity(call.id, call.name, call.args, 'ongoing');
    if (
      this.subagentPhase === undefined ||
      this.subagentPhase === 'queued' ||
      this.subagentPhase === 'spawning'
    ) {
      this.subagentPhase = 'running';
    }
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendSubToolCallDelta(delta: {
    id: string;
    name?: string | undefined;
    argumentsPart: string | null;
  }): void {
    const existing = this.ongoingSubCalls.get(delta.id);
    const nextArgsText = appendStreamingArgsPreview(
      existing?.streamingArguments,
      delta.argumentsPart,
    );
    const parsed = parseArgsPreview(nextArgsText);
    this.ongoingSubCalls.set(delta.id, {
      name: delta.name ?? existing?.name ?? 'Tool',
      args: parsed,
      streamingArguments: nextArgsText,
    });
    this.upsertSubToolActivity(delta.id, delta.name ?? existing?.name ?? 'Tool', parsed, 'ongoing');
    if (
      this.subagentPhase === undefined ||
      this.subagentPhase === 'queued' ||
      this.subagentPhase === 'spawning'
    ) {
      this.subagentPhase = 'running';
    }
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendSubToolLiveOutput(id: string, text: string, options?: { readonly replace?: boolean }): void {
    if (text.length === 0) return;
    const activity = this.subToolActivities.get(id);
    const ongoing = this.ongoingSubCalls.get(id);
    if (activity === undefined && ongoing === undefined) return;
    const name = activity?.name ?? ongoing?.name ?? 'Tool';
    const args = activity?.args ?? ongoing?.args ?? {};
    const existingOutput = options?.replace === true ? '' : (activity?.output ?? '');
    let output = existingOutput + text;
    if (output.length > MAX_LIVE_OUTPUT_CHARS) {
      output = `[…truncated]\n${output.slice(output.length - MAX_LIVE_OUTPUT_CHARS)}`;
    }
    this.upsertSubToolActivity(id, name, args, activity?.phase ?? 'ongoing', output);
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  finishSubToolCall(result: {
    tool_call_id: string;
    output: string;
    is_error?: boolean | undefined;
  }): void {
    const ongoing = this.ongoingSubCalls.get(result.tool_call_id);
    if (ongoing === undefined) return;
    this.ongoingSubCalls.delete(result.tool_call_id);
    this.finishedSubCalls.push({
      name: ongoing.name,
      args: ongoing.args,
      output: result.output,
      isError: result.is_error ?? false,
    });
    this.upsertSubToolActivity(
      result.tool_call_id,
      ongoing.name,
      ongoing.args,
      result.is_error === true ? 'failed' : 'done',
      result.output,
    );
    while (this.finishedSubCalls.length > MAX_SUB_TOOL_CALLS_SHOWN) {
      this.finishedSubCalls.shift();
      this.hiddenSubCallCount += 1;
    }
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  private buildHeader(): HeaderContent {
    const { toolCall, result } = this;
    const isFinished = result !== undefined;
    const isError = result?.is_error ?? false;
    const isTruncated = toolCall.truncated === true && !isFinished;
    const bullet = this.statusMarker();

    if (toolCall.name === 'ExitPlanMode') {
      const label = currentTheme.boldFg('primary', 'Current plan');
      if (!isFinished || result === undefined || result.is_error === true) {
        return label;
      }
      const outcome = interpretExitPlanModeOutcome(result.output);
      if (outcome.kind === 'approved') {
        const chipText =
          outcome.chosen !== undefined && outcome.chosen.length > 0
            ? `Approved: ${outcome.chosen}`
            : 'Approved';
        return `${label}${currentTheme.fg('success', ` · ${chipText}`)}`;
      }
      if (outcome.kind === 'auto_approved') {
        return `${label}${currentTheme.fg('warning', ' · Auto-approved')}`;
      }
      return label;
    }

    if (toolCall.name === 'AskUserQuestion') {
      const isBackgroundAsk = toolCall.args['background'] === true;
      const label = isFinished
        ? isError
          ? 'Could not collect your input'
          : isBackgroundAsk
            ? 'Started background question'
          : 'Collected your answers'
        : isBackgroundAsk
          ? 'Starting background question'
          : 'Waiting for your input';
      const tone = isError ? 'error' : 'primary';
      return `${bullet}${currentTheme.boldFg(tone, label)}`;
    }

    if (toolCall.name === 'NotifyUser' && isExperimentalFlagEnabled('notify_user')) {
      if (isTruncated) {
        return `${bullet}${currentTheme.boldFg('error', 'Update cut off')}${currentTheme.dim(' (arguments truncated by max_tokens)')}`;
      }
      const delivery = notifyResultState(result?.output);
      if (!isFinished || (!isError && delivery === 'displayed')) {
        const title = notifyUserTitle(isFinished ? toolCall.args : notifyUserLiveArgs(toolCall));
        const content: NotifyUserHeaderContent = {
          head: notifyUserPrefix(this.ui?.mode === 'fullscreen'),
          flex: { text: title, style: notifyTitleStyle, keep: 'head' },
          tail: '',
          notifyUserTitle: title,
        };
        return content;
      }
      const label = isError
        ? 'Could not send you an update'
        : delivery === 'displayed'
          ? 'Sent you an update'
          : delivery === 'suppressed'
            ? 'Update not displayed'
            : 'Update completed';
      const tone = isError ? 'error' : 'primary';
      const preview = extractKeyArgumentDetail(toolCall.name, toolCall.args, this.workspaceDir);
      const head = `${bullet}${currentTheme.boldFg(tone, label)}`;
      if (preview === null) return head;
      return {
        head: `${head}${currentTheme.dim(' (')}`,
        flex: { text: preview.text, style: dimHeaderStyle, keep: 'head' },
        tail: currentTheme.dim(')'),
      };
    }

    if (toolCall.name === 'Bash') {
      if (isTruncated) {
        return `${bullet}${currentTheme.fg('error', 'Truncated')} ${currentTheme.boldFg('primary', 'Bash')}`;
      }
      const label = isFinished ? 'Ran a command' : 'Running a command';
      const tone = isError ? 'error' : 'primary';
      const command = extractKeyArgumentDetail(toolCall.name, toolCall.args, this.workspaceDir);
      const chipStr = isFinished && result !== undefined ? this.buildHeaderChip(result) : '';
      const head = `${bullet}${currentTheme.boldFg(tone, label)}`;
      if (command === null) return `${head}${chipStr}`;
      return {
        head: `${head}${currentTheme.dim(' · $ ')}`,
        flex: { text: command.text, style: dimHeaderStyle, keep: 'head' },
        tail: chipStr,
      };
    }

    const goalHeader = buildGoalToolHeader({
      toolCall,
      result,
      bullet,
      chip: isFinished && result !== undefined ? this.buildHeaderChip(result) : '',
    });
    if (goalHeader !== undefined) return goalHeader;

    const waitForHeader = buildWaitForHeader({
      toolCall,
      result,
      bullet,
      chip: isFinished && result !== undefined ? this.buildHeaderChip(result) : '',
    });
    if (waitForHeader !== undefined) return waitForHeader;

    if (this.isSingleSubagentView()) {
      return this.buildSingleSubagentHeader();
    }

    const finishedVerb =
      toolCall.name === 'TodoList' && isTodoListRead(toolCall.args) ? 'Read' : 'Used';
    const verb = isFinished ? finishedVerb : isTruncated ? 'Truncated' : 'Using';
    const keyArg = extractKeyArgumentDetail(toolCall.name, toolCall.args, this.workspaceDir);
    const decoded = decodeMcpToolName(toolCall.name);
    const verbStyled = isTruncated
      ? currentTheme.fg('error', verb)
      : verb;
    const toolLabel =
      decoded !== null
        ? `${currentTheme.boldFg('primary', decoded.toolName)}${currentTheme.dim(` · MCP/${decoded.serverName}`)}`
        : currentTheme.boldFg('primary', toolCall.name);
    let chipStr = '';
    if (isFinished && result) chipStr = this.buildHeaderChip(result);
    const head = `${bullet}${verbStyled} ${toolLabel}`;
    if (keyArg === null) return `${head}${chipStr}`;
    return {
      head: `${head}${currentTheme.dim(' (')}`,
      flex: { text: keyArg.text, style: dimHeaderStyle, keep: keyArg.keep },
      tail: `${currentTheme.dim(')')}${chipStr}`,
    };
  }

  private buildHeaderChip(result: ToolResultBlockData): string {
    const text = chipText(this.toolCall, result);
    if (text.length === 0) return '';
    if (result.is_error) return currentTheme.fg('error', ` · ${text}`);
    return currentTheme.dim(` · ${text}`);
  }

  private rebuildContent(): void {
    this.hiddenContent = undefined;
    this.collapsedOutcomeClipCache = undefined;
    while (this.children.length > this.callPreviewEndIndex) {
      this.children.pop();
    }
    this.buildProgressBlock();
    this.buildDetachHintBlock();
    this.buildLiveOutputBlock();
    this.buildContent();
    this.buildSubagentBlock();
  }

  private rebuildBody(): void {
    this.hiddenContent = undefined;
    this.collapsedOutcomeClipCache = undefined;
    while (this.children.length > CARD_PREAMBLE_CHILDREN) {
      this.children.pop();
    }
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildProgressBlock();
    this.buildDetachHintBlock();
    this.buildLiveOutputBlock();
    this.buildContent();
    this.buildSubagentBlock();
  }

  private buildProgressBlock(): void {
    if (this.progressLines.length === 0) return;
    if (this.result !== undefined) return;
    for (const raw of this.progressLines) {
      if (raw.length === 0) {
        this.addChild(new Text('', 2, 0));
        continue;
      }
      PROGRESS_URL_RE.lastIndex = 0;
      const styled = PROGRESS_URL_RE.test(raw)
        ? raw.replace(PROGRESS_URL_RE, (url) => {
          const visible = currentTheme.underlineFg('warning', url);
          return `\u001B]8;;${url}\u001B\\${visible}\u001B]8;;\u001B\\`;
        })
        : currentTheme.dim(raw);
      PROGRESS_URL_RE.lastIndex = 0;
      this.addChild(new Text(styled, 2, 0));
    }
  }

  private buildLiveOutputBlock(): void {
    if (this.result !== undefined) return;
    if (this.liveOutput.length === 0) return;
    if (!this.expanded) {
      const lines = nonEmptyLines(this.liveOutput);
      const latest = lines.at(-1);
      if (latest !== undefined) {
        this.addChild(outcomeLine(latest, lines.length > 1 ? 'above' : undefined));
      }
      return;
    }
    this.addChild(
      new ShellExecutionComponent({
        result: {
          tool_call_id: this.toolCall.id,
          output: this.liveOutput,
          is_error: false,
        },
        expanded: true,
      }),
    );
  }

  private buildSubagentBlock(): void {
    if (
      this.subagentAgentId === undefined &&
      this.ongoingSubCalls.size === 0 &&
      this.finishedSubCalls.length === 0 &&
      this.subagentText.length === 0 &&
      this.subagentPhase === undefined &&
      this.backgroundTaskTerminalPhase === undefined
    ) {
      return;
    }

    if (this.isSingleSubagentView()) {
      this.buildSingleSubagentBlock();
      return;
    }

    const phaseChip = this.formatPhaseChip();
    const headerLabel =
      this.subagentAgentName !== undefined
        ? `subagent ${this.subagentAgentName} (${this.formatAgentId()})`
        : `subagent (${this.formatAgentId()})`;
    this.addChild(new Text(`  ${currentTheme.dim(`↳ ${headerLabel}`)}${phaseChip}`, 0, 0));

    if (this.hiddenSubCallCount > 0) {
      const suffix = this.hiddenSubCallCount > 1 ? 's' : '';
      this.addChild(
        new Text(
          currentTheme.italic(currentTheme.dim(`    ${String(this.hiddenSubCallCount)} more tool call${suffix} …`)),
          0,
          0,
        ),
      );
    }

    for (const sub of this.finishedSubCalls) {
      const mark = sub.isError
        ? currentTheme.fg('error', '✗')
        : currentTheme.fg('success', '•');
      const keyArg = extractKeyArgument(sub.name, sub.args, this.workspaceDir);
      const nameCol = currentTheme.fg('primary', sub.name);
      const argCol = keyArg ? currentTheme.dim(` (${keyArg})`) : '';
      this.addChild(new Text(`    ${mark} Used ${nameCol}${argCol}`, 0, 0));
    }

    for (const [id, call] of this.ongoingSubCalls) {
      const keyArg = extractKeyArgument(call.name, call.args, this.workspaceDir);
      const nameCol = currentTheme.fg('primary', call.name);
      const argCol = keyArg ? currentTheme.dim(` (${keyArg})`) : '';
      void id;
      this.addChild(new Text(`    ${currentTheme.dim('…')} Using ${nameCol}${argCol}`, 0, 0));
    }

    if (this.subagentText.length > 0) {
      const tailLines = tailSourceLines(this.subagentText, 3).split('\n');
      for (const line of tailLines) {
        this.addChild(new Text(`    ${currentTheme.dim(line)}`, 0, 0));
      }
    }

    if (this.subagentPhase === 'done' && this.subagentResultSummary !== undefined) {
      const summaryLines = this.subagentResultSummary.split('\n').slice(0, 2);
      for (const line of summaryLines) {
        this.addChild(new Text(`    ${currentTheme.dim('└')} ${line}`, 0, 0));
      }
    }

    if (this.subagentPhase === 'failed' && this.subagentError !== undefined) {
      const errLines = this.subagentError.split('\n');
      for (const line of errLines) {
        this.addChild(new Text(`    ${currentTheme.fg('error', '└')} ${line}`, 0, 0));
      }
    }
  }

  private formatPhaseChip(): string {
    if (this.subagentPhase === undefined) return '';
    const parts: string[] = [];
    switch (this.subagentPhase) {
      case 'queued':
        parts.push('○ queued');
        break;
      case 'spawning':
        parts.push('↻ starting…');
        break;
      case 'running':
        parts.push('↻ running');
        break;
      case 'done': {
        parts.push(currentTheme.fg('success', '✓ done'));
        const toolCount = this.finishedSubCalls.length + this.hiddenSubCallCount;
        if (toolCount > 0) parts.push(`${String(toolCount)} tool${toolCount > 1 ? 's' : ''}`);
        const tokens =
          formatSubagentContextTokens(this.subagentContextTokens) ??
          formatSubagentTokens(this.subagentUsage);
        if (tokens !== undefined) parts.push(tokens);
        break;
      }
      case 'failed':
        parts.push(currentTheme.fg('error', '✗ failed'));
        break;
      case 'backgrounded':
        parts.push('◐ backgrounded');
        break;
    }
    return parts.length > 0 ? currentTheme.dim(` · ${parts.join(' · ')}`) : '';
  }

  private formatAgentId(): string {
    const id = this.subagentAgentId ?? '';
    return id.length > 10 ? id.slice(0, 10) + '…' : id;
  }

  private hasSubagentState(): boolean {
    return (
      this.subagentAgentId !== undefined ||
      this.ongoingSubCalls.size > 0 ||
      this.finishedSubCalls.length > 0 ||
      this.subToolActivities.size > 0 ||
      this.subagentText.length > 0 ||
      this.subagentThinkingText.length > 0 ||
      this.subagentPhase !== undefined ||
      this.backgroundTaskTerminalPhase !== undefined
    );
  }

  private isSingleSubagentView(): boolean {
    return this.toolCall.name === 'Agent' && this.hasSubagentState();
  }

  private getDerivedSubagentPhase(): SubagentPhase | undefined {
    if (this.backgroundTaskTerminalPhase !== undefined) {
      return this.backgroundTaskTerminalPhase;
    }
    if (this.detachedFromForeground && this.subagentPhase === 'backgrounded') {
      return 'backgrounded';
    }
    if (this.result !== undefined) return this.result.is_error ? 'failed' : 'done';
    return this.subagentPhase;
  }

  private buildSingleSubagentHeader(): string {
    const phase = this.getDerivedSubagentPhase();
    const isDone = phase === 'done';
    const marker = this.buildSingleSubagentMarker(phase);
    const labelText = formatSubagentLabel(this.subagentAgentName);
    const label = currentTheme.boldFg('primary', labelText);
    const status = this.formatSingleSubagentStatus(phase);
    const rawDescription = str(this.toolCall.args['description']);
    const description =
      rawDescription.length > MAX_SUBAGENT_DESCRIPTION_LENGTH
        ? `${rawDescription.slice(0, MAX_SUBAGENT_DESCRIPTION_LENGTH - 1)}…`
        : rawDescription;
    const descriptionPlain = description.length > 0 ? ` (${description})` : '';
    const descriptionText = descriptionPlain.length > 0 ? currentTheme.dim(descriptionPlain) : '';
    const statsText = this.formatSingleSubagentStatsText();
    if (isDone) {
      return `${marker}${currentTheme.boldFg('success', labelText)} ${currentTheme.fg('success', `Completed${descriptionPlain}${statsText}`)}`;
    }
    const stats = currentTheme.dim(statsText);
    return `${marker}${label} ${status}${descriptionText}${stats}`;
  }

  private formatSingleSubagentStatus(phase: SubagentPhase | undefined): string {
    switch (phase) {
      case 'done':
        return currentTheme.fg('success', 'Completed');
      case 'failed':
        return currentTheme.fg('error', 'Failed');
      case 'running':
        return currentTheme.fg('primary', 'Running');
      case 'backgrounded':
        return 'Backgrounded';
      case 'queued':
        return currentTheme.fg('primary', 'Queued');
      case 'spawning':
      case undefined:
        return currentTheme.fg('primary', 'Starting');
    }
  }

  private formatSingleSubagentStatsText(): string {
    const parts: string[] = [];
    if (this.subagentModel !== undefined) parts.push(this.subagentModel);
    if (this.subagentEffort !== undefined) parts.push(this.subagentEffort);
    parts.push(`${String(this.subToolActivities.size)} tool${this.subToolActivities.size === 1 ? '' : 's'}`);
    const elapsed = this.getSubagentElapsedSeconds();
    if (elapsed !== undefined) parts.push(formatElapsed(elapsed));
    const tokens =
      this.subagentContextTokens && this.subagentContextTokens > 0
        ? this.subagentContextTokens
        : this.subagentUsage === undefined
          ? 0
          : usageTotal(this.subagentUsage);
    if (tokens > 0) parts.push(formatTokens(tokens));
    return ` · ${parts.join(' · ')}`;
  }

  private getSubagentElapsedSeconds(): number | undefined {
    if (this.subagentStartedAtMs === undefined) return undefined;
    const end = this.subagentEndedAtMs ?? Date.now();
    return Math.max(0, Math.floor((end - this.subagentStartedAtMs) / 1000));
  }

  private buildSingleSubagentMarker(phase: SubagentPhase | undefined): string {
    if (phase === 'failed') return currentTheme.fg('error', '✗ ');
    if (phase === 'done') return currentTheme.fg('success', STATUS_BULLET);
    if (phase === 'backgrounded') return currentTheme.dim('◐ ');
    const frame = BRAILLE_SPINNER_FRAMES[this.subagentSpinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0];
    return currentTheme.fg('primary', `${frame} `);
  }

  private buildSingleSubagentBlock(): void {
    const phase = this.getDerivedSubagentPhase();

    this.addChild(new Text(this.buildSingleSubagentSummaryLine(), 0, 0));

    if (phase === 'failed') {
      this.addChild(this.buildSingleSubagentResultWindow('error'));
      return;
    }
    if (phase === 'done' || phase === 'backgrounded') {
      this.addChild(this.buildSingleSubagentResultWindow('output'));
      return;
    }
    this.addChild(this.buildSingleSubagentActiveWindow());
  }

  private getCurrentSubToolActivity(): SubToolActivity | undefined {
    let latestOngoing: SubToolActivity | undefined;
    let latest: SubToolActivity | undefined;
    for (const activity of this.subToolActivities.values()) {
      if (latest === undefined || activity.orderSeq > latest.orderSeq) latest = activity;
      if (
        activity.phase === 'ongoing' &&
        (latestOngoing === undefined || activity.orderSeq > latestOngoing.orderSeq)
      ) {
        latestOngoing = activity;
      }
    }
    return latestOngoing ?? latest;
  }

  private getActiveSubagentContent(): { text: string; tone: 'text' | 'thinking' } | undefined {
    const current = this.getCurrentSubToolActivity();
    if (
      current?.phase === 'ongoing' &&
      current.output !== undefined &&
      current.output.trim().length > 0 &&
      (current.name === 'Bash' || current.name === 'WaitFor' || isGenericToolResult(current.name))
    ) {
      return { text: current.output, tone: 'text' };
    }
    if (this.lastSubagentStreamKind === 'thinking' && this.subagentThinkingText.trim().length > 0) {
      return { text: this.subagentThinkingText.trimEnd(), tone: 'thinking' };
    }
    if (this.subagentText.trim().length > 0) {
      return { text: this.subagentText, tone: 'text' };
    }
    if (this.subagentThinkingText.trim().length > 0) {
      return { text: this.subagentThinkingText.trimEnd(), tone: 'thinking' };
    }
    return undefined;
  }

  private buildSingleSubagentSummaryLine(): string {
    const toolCount = this.subToolActivities.size;
    const countLabel = `${String(toolCount)} tool${toolCount === 1 ? '' : 's'}`;
    const current = this.getCurrentSubToolActivity();
    if (current === undefined) {
      return currentTheme.dim(`  · ${countLabel}`);
    }
    const verb = current.phase === 'ongoing' ? 'Using' : 'Used';
    const keyArg = extractKeyArgument(current.name, current.args, this.workspaceDir);
    const nameCol = currentTheme.fg('primary', current.name);
    const argCol = keyArg ? currentTheme.dim(` (${keyArg})`) : '';
    const mark =
      current.phase === 'failed'
        ? currentTheme.fg('error', ' ✗')
        : current.phase === 'done'
          ? currentTheme.fg('success', ' ✓')
          : '';
    return `${currentTheme.dim(`  · ${countLabel} · `)}${verb} ${nameCol}${argCol}${mark}`;
  }

  private buildSingleSubagentActiveWindow(): Component {
    const gutter = currentTheme.dim('│');
    const content = this.getActiveSubagentContent();
    const text =
      content === undefined ? '…' : tailSourceLines(content.text, THINKING_PREVIEW_LINES * 4);
    const styled =
      content === undefined
        ? currentTheme.dim(text)
        : content.tone === 'thinking'
          ? currentTheme.dim(text)
          : currentTheme.fg('textDim', text);
    return new PrefixedWrappedLine(
      `  ${gutter} `,
      `  ${gutter} `,
      styled,
      THINKING_PREVIEW_LINES,
      THINKING_PREVIEW_LINES,
    );
  }

  private buildSingleSubagentResultWindow(kind: 'output' | 'error'): Component {
    const gutter = currentTheme.dim('│');
    const source = kind === 'error' ? this.subagentError : this.subagentText;
    const text = source === undefined ? '' : tailNonEmptyLines(source, 2).join('\n');
    const styled =
      kind === 'error' ? currentTheme.fg('error', text) : currentTheme.fg('text', text);
    return new PrefixedWrappedLine(
      `  ${gutter} `,
      `  ${gutter} `,
      styled,
      THINKING_PREVIEW_LINES,
      THINKING_PREVIEW_LINES,
    );
  }

  private buildCallPreview(): void {
    const name = this.toolCall.name;
    if (name === 'ExitPlanMode') {
      this.buildPlanPreview();
      return;
    }
    if (this.result === undefined && this.toolCall.truncated === true) {
      this.addChild(
        new Text(
          currentTheme.dim('Tool call arguments truncated by max_tokens — call never executed.'),
          2,
          0,
        ),
      );
      return;
    }
    if (name === 'NotifyUser' && isExperimentalFlagEnabled('notify_user')) {
      if (!this.expanded) return;
      const inFlight = this.result === undefined;
      const args = inFlight ? notifyUserLiveArgs(this.toolCall) : this.toolCall.args;
      const message = str(args['message']).trim();
      if (message.length === 0) return;
      const displayed =
        this.result !== undefined &&
        this.result.is_error !== true &&
        notifyResultState(this.result.output) === 'displayed';
      const MarkdownComponent = inFlight || displayed ? ToolOutputMarkdown : Markdown;
      this.addChild(
        new MarkdownComponent(message, MESSAGE_INDENT.length, 0, this.markdownTheme, undefined, {
          ...createMarkdownOptions(),
          copySource: true,
        }),
      );
      return;
    }
    if (this.result === undefined && this.toolCall.streamingArguments !== undefined) {
      this.buildStreamingPreview(this.toolCall.streamingArguments);
      return;
    }
    const shouldCap = !this.expanded;
    if (name === 'Write') {
      const content = str(this.toolCall.args['content']);
      if (content.length === 0) return;
      const filePath = str(this.toolCall.args['file_path'] ?? this.toolCall.args['path']);
      const lang = langFromPath(filePath);
      const allLines = highlightLines(content, lang);
      const writeShouldCap = !this.expanded && allLines.length > COMMAND_PREVIEW_LINES + 1;
      const shown = writeShouldCap ? allLines.slice(0, COMMAND_PREVIEW_LINES) : allLines;
      const remaining = allLines.length - shown.length;
      for (const [i, line] of shown.entries()) {
        const lineNum = currentTheme.dim(String(i + 1).padStart(4) + '  ');
        this.addChild(new Text(lineNum + line, 2, 0));
      }
      if (writeShouldCap && remaining > 0) {
        this.addChild(
          new Text(
            currentTheme.dim(
              `… (${String(remaining)} more lines, ${String(allLines.length)} total, ctrl+o to expand)`,
            ),
            2,
            0,
          ),
        );
      }
    } else if (name === 'Edit') {
      const oldStr = str(this.toolCall.args['old_string']);
      const newStr = str(this.toolCall.args['new_string']);
      if (oldStr.length === 0 && newStr.length === 0) return;
      const filePath = str(this.toolCall.args['file_path'] ?? this.toolCall.args['path']);
      const lines = renderDiffLinesClustered(oldStr, newStr, filePath, {
        contextLines: 3,
        ...(shouldCap ? { maxLines: COMMAND_PREVIEW_LINES } : {}),
      });
      for (const [index, line] of lines.entries()) {
        const text = new Text(line, 2, 0);
        this.addChild(index === 0 ? new CardOnly(text) : text);
      }
    } else if (name === 'Bash') {
      const executionCwd = this.stampedExecutionCwd();
      if (executionCwd !== undefined) {
        this.addChild(new Text(currentTheme.dim(`cwd: ${executionCwd}`), 2, 0));
      }
      if (!this.expanded) return;
      const command = str(this.toolCall.args['command']);
      if (command.length === 0) return;
      this.addChild(
        new CardOnly(
          new ShellExecutionComponent({
            command,
            showCommand: true,
            commandPreviewLines: undefined,
          }),
        ),
      );
    }
  }

  private stampedExecutionCwd(): string | undefined {
    const display = this.toolCall.display;
    if (display?.kind !== 'command') return undefined;
    const cwd = display.cwd;
    if (cwd === undefined || cwd.length === 0 || cwd === this.workspaceDir) return undefined;
    return cwd;
  }

  private buildStreamingPreview(streamText: string): void {
    const name = this.toolCall.name;
    const previewText = streamText.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);
    if (name === 'Write') {
      const content = extractPartialStringField(previewText, 'content');
      if (content === undefined || content.length === 0) return;
      const filePath =
        extractPartialStringField(previewText, 'file_path') ??
        extractPartialStringField(previewText, 'path') ??
        '';
      const lang = langFromPath(filePath);
      const allLines = highlightLines(content, lang);
      const maxLines = COMMAND_PREVIEW_LINES;
      const scrollLines =
        allLines.length > maxLines
          ? allLines.slice(allLines.length - maxLines)
          : allLines;
      for (const [i, line] of scrollLines.entries()) {
        const originalLineNumber =
          allLines.length > maxLines
            ? allLines.length - maxLines + i
            : i;
        const lineNum = currentTheme.dim(String(originalLineNumber + 1).padStart(4) + '  ');
        this.addChild(new Text(lineNum + line, 2, 0));
      }
      return;
    }
    if (name === 'Edit') {
      const filePath =
        extractPartialStringField(previewText, 'file_path') ??
        extractPartialStringField(previewText, 'path') ??
        '';
      const bytes = Buffer.byteLength(previewText, 'utf8');
      const startedAtMs = this.toolCall.streamingStartedAtMs;
      const elapsedSeconds =
        startedAtMs === undefined ? 0 : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
      const target = filePath.length > 0 ? ` for ${filePath}` : '';
      const progress = `Preparing changes${target}... ${formatByteSize(bytes)} · ${formatElapsed(
        elapsedSeconds,
      )} elapsed`;
      this.addChild(new Text(currentTheme.dim(progress), 2, 0));
      return;
    }
    if (name === 'Bash' && this.expanded) {
      const cmd = extractPartialStringField(previewText, 'command');
      if (cmd === undefined || cmd.length === 0) return;
      this.addChild(
        new CardOnly(
          new ShellExecutionComponent({
            command: cmd,
            showCommand: true,
            commandPreviewLines: undefined,
          }),
        ),
      );
    }
  }

  private buildPlanPreview(): void {
    const plan = this.resolvePlanForPreview();
    if (plan.length === 0) return;
    const path = this.resolvePlanPath();
    this.addChild(
      new PlanBoxComponent(plan, this.markdownTheme, currentTheme.color('success'), path, {
        status: this.resolvePlanBoxStatus(),
      }),
    );
  }

  private resolvePlanForPreview(): string {
    const inlinePlan = str(this.toolCall.args['plan']);
    if (inlinePlan.length > 0) return inlinePlan;
    if (this.result !== undefined && !this.result.is_error) {
      const approved = extractApprovedPlan(this.result.output);
      if (approved.length > 0) return approved;
    }
    return this.currentPlan ?? '';
  }

  private resolvePlanPath(): string | undefined {
    if (this.result !== undefined && !this.result.is_error) {
      const fromResult = interpretExitPlanModeOutcome(this.result.output).path;
      if (fromResult !== undefined && fromResult.length > 0) return fromResult;
    }
    return this.planPath;
  }

  private resolvePlanBoxStatus(): { label: string; colorHex: string } | undefined {
    const result = this.result;
    if (this.toolCall.name !== 'ExitPlanMode' || result === undefined) return undefined;
    if (!isExitPlanModeOutcomeOutput(result.output)) return undefined;
    const outcome = interpretExitPlanModeOutcome(result.output);
    if (outcome.kind !== 'rejected') return undefined;
    return { label: 'Rejected', colorHex: currentTheme.color('error') };
  }

  private buildContent(): void {
    const { result } = this;
    if (result === undefined) return;

    if (this.toolCall.name === 'AgentSwarm') {
      this.buildAgentSwarmResultSummary(result);
      return;
    }

    if (!result.output) return;

    if (this.isSingleSubagentView()) {
      return;
    }

    if (result.output.trimStart().startsWith('<system-reminder>')) {
      return;
    }

    if (this.toolCall.name === 'ExitPlanMode' && isExitPlanModeOutcomeOutput(result.output)) {
      const outcome = interpretExitPlanModeOutcome(result.output);
      if (outcome.kind === 'rejected' && outcome.feedback !== undefined) {
        const trimmed = outcome.feedback.trim();
        if (trimmed.length > 0) {
          const labelTone = (text: string) => currentTheme.boldFg('warning', text);
          this.addChild(new Text(labelTone('↪ Suggestion'), 2, 0));
          for (const line of trimmed.split('\n')) {
            this.addChild(new Text(line, 4, 0));
          }
        }
      }
      return;
    }

    if (this.toolCall.name === 'TodoList' && !result.is_error) {
      const todos = todoListFromResult(result.output);
      if (todos.length > 0) this.addChild(new TodoCardBody(todos, this.expanded));
      return;
    }

    if (this.toolCall.name === 'EnterPlanMode' && !result.is_error) {
      return;
    }

    if (
      this.toolCall.name === 'NotifyUser' &&
      isExperimentalFlagEnabled('notify_user') &&
      !result.is_error &&
      notifyResultState(result.output) === 'displayed'
    ) {
      return;
    }

    if (
      this.toolCall.name === 'AskUserQuestion' &&
      this.toolCall.args['background'] !== true &&
      !result.is_error &&
      this.renderAskUserQuestionResult(result.output)
    ) {
      return;
    }

    const renderer = pickResultRenderer(this.toolCall.name);
    const components = renderer(this.toolCall, result, {
      expanded: this.expanded,
    });
    for (const component of components) {
      this.addChild(component);
    }
  }

  private buildAgentSwarmResultSummary(result: ToolResultBlockData): void {
    const summary = agentSwarmResultSummaryFromOutput(result.output);
    const dim = (s: string): string => currentTheme.fg('textDim', s);
    const segments: string[] = [];

    if (summary.completed > 0) {
      segments.push(
        currentTheme.fg('success', `${SUCCESS_MARK.trimEnd()} ${String(summary.completed)} completed`),
      );
    }
    if (summary.failed > 0) {
      segments.push(
        currentTheme.fg('error', `${FAILURE_MARK.trimEnd()} ${String(summary.failed)} failed`),
      );
    }
    if (summary.aborted > 0) {
      segments.push(
        currentTheme.fg('warning', `${ABORTED_MARK} ${String(summary.aborted)} aborted`),
      );
    }

    if (segments.length > 0) {
      this.addChild(new Text(`${dim('Agent swarm: ')}${segments.join(dim(' · '))}`, 2, 0));
      return;
    }

    const isAborted = result.is_error === true && /\b(?:aborted|cancelled)\b/i.test(result.output);
    const colorToken = isAborted ? 'warning' : result.is_error === true ? 'error' : 'success';
    const label = isAborted
      ? `${ABORTED_MARK} Aborted.`
      : result.is_error === true
        ? `${FAILURE_MARK.trimEnd()} Failed.`
        : `${SUCCESS_MARK.trimEnd()} Completed.`;
    this.addChild(new Text(`${dim('Agent swarm: ')}${currentTheme.fg(colorToken, label)}`, 2, 0));
  }

  private renderAskUserQuestionResult(output: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;

    const accent = (text: string) => currentTheme.fg('primary', text);

    const answers = (parsed as { answers?: unknown }).answers;
    const note = (parsed as { note?: unknown }).note;

    const hasAnswers =
      typeof answers === 'object' && answers !== null && Object.keys(answers).length > 0;

    if (!hasAnswers) {
      const noteText =
        typeof note === 'string' && note.length > 0 ? note : 'User dismissed the question.';
      this.addChild(new Text(currentTheme.dim(`  ${noteText}`), 0, 0));
      return true;
    }

    for (const [question, answer] of Object.entries(answers as Record<string, unknown>)) {
      const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer);
      this.addChild(new Text(`  ${currentTheme.dim('Q')}  ${question}`, 0, 0));
      this.addChild(new Text(`  ${accent('→')}  ${answerText}`, 0, 0));
    }
    return true;
  }
}

function computeLatestActivity(
  ongoing: ReadonlyMap<string, OngoingSubCall>,
  finished: readonly FinishedSubCall[],
  text: string,
  workspaceDir?: string,
): string | undefined {
  if (ongoing.size > 0) {
    const lastOngoing = [...ongoing.values()].at(-1);
    if (lastOngoing !== undefined) {
      return formatActivityLine('Using', lastOngoing.name, lastOngoing.args, workspaceDir);
    }
  }
  if (finished.length > 0) {
    const last = finished.at(-1);
    if (last !== undefined) {
      return formatActivityLine('Used', last.name, last.args, workspaceDir);
    }
  }
  if (text.length > 0) {
    const tail = lastNonEmptyLine(text);
    if (tail !== undefined) return tail;
  }
  return undefined;
}

function formatTokens(n: number): string {
  return `${formatTokenCount(n)} tok`;
}

function formatActivityLine(
  verb: string,
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string {
  const keyArg = extractKeyArgument(toolName, args, workspaceDir);
  return keyArg ? `${verb} ${toolName} (${keyArg})` : `${verb} ${toolName}`;
}
