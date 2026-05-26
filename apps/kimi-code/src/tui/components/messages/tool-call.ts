/**
 * Renders a tool call entry in the transcript.
 * Supports expand/collapse via Ctrl+O.
 */

import { isAbsolute, relative, sep } from 'node:path';

import { Container, Text, Spacer, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, MarkdownTheme, TUI } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';
import { COMMAND_PREVIEW_LINES } from '#/tui/constant/rendering';
import {
  STREAMING_ARGS_FIELD_RE,
  STREAMING_ARGS_PREVIEW_MAX_CHARS,
} from '#/tui/constant/streaming';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import { appendStreamingArgsPreview } from '#/tui/utils/event-payload';
import { decodeMcpToolName } from '#/tui/utils/mcp-tool-name';

import { PlanBoxComponent } from './plan-box';
import { ShellExecutionComponent } from './shell-execution';
import { countNonEmptyLines, pickChip } from './tool-renderers/chip';
import { pickResultRenderer } from './tool-renderers/registry';

const MAX_ARG_LENGTH = 60;
const MAX_SUB_TOOL_CALLS_SHOWN = 4;
const MAX_SINGLE_SUBAGENT_TOOL_ROWS = 4;
const APPROVED_PLAN_MARKER = '## Approved Plan:';
const STREAMING_PROGRESS_INTERVAL_MS = 1000;
const SUBAGENT_ELAPSED_INTERVAL_MS = 1000;
const PROGRESS_URL_RE = /https?:\/\/\S+/g;

type SubagentTextKind = 'thinking' | 'text';

interface SubagentTokenUsage {
  readonly input?: number | undefined;
  readonly inputOther?: number | undefined;
  readonly inputCacheRead?: number | undefined;
  readonly inputCacheCreation?: number | undefined;
  readonly output: number;
}

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
  readonly orderSeq: number;
}

/**
 * Immutable subagent state snapshot. `AgentGroupComponent` reads one-time
 * views via `ToolCallComponent.getSubagentSnapshot()` and renders its own
 * branch lines; `onSnapshotChange` notifies it when state changes.
 *
 * `latestActivity` priority, used only while running:
 *   1. latest ongoing sub-tool (`Using {name} ({keyArg})`)
 *   2. latest finished sub-tool (`Used {name} ({keyArg})`)
 *   3. last non-empty line from accumulated subagent text
 */
export interface ToolCallSubagentSnapshot {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolCallDescription: string;
  readonly agentName: string | undefined;
  readonly phase: 'spawning' | 'running' | 'done' | 'failed' | 'backgrounded' | undefined;
  readonly toolCount: number;
  readonly tokens: number;
  readonly isError: boolean;
  readonly errorText: string | undefined;
  readonly latestActivity: string | undefined;
}

/**
 * Immutable Read tool state snapshot. `ReadGroupComponent` reads one-time
 * views via `ToolCallComponent.getReadSnapshot()` and sums lines for the group
 * header. `lines` is 0 while pending or failed, and the non-empty result line
 * count when done, matching the single-card chip.
 */
export interface ToolCallReadSnapshot {
  readonly toolCallId: string;
  readonly filePath: string | undefined;
  readonly phase: 'pending' | 'done' | 'failed';
  readonly lines: number;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function usageInputTotal(usage: SubagentTokenUsage): number {
  return (
    usage.input ??
    (usage.inputOther ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0)
  );
}

function formatSubagentTokens(usage: SubagentTokenUsage | undefined): string | undefined {
  if (usage === undefined) return undefined;
  const total = usageInputTotal(usage) + usage.output;
  if (total <= 0) return undefined;
  const formatted = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
  return `${formatted} tok`;
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
  const markerIndex = output.indexOf(APPROVED_PLAN_MARKER);
  if (markerIndex < 0) return '';
  return output.slice(markerIndex + APPROVED_PLAN_MARKER.length).trim();
}

interface ExitPlanModeOutcome {
  readonly kind: 'approved' | 'rejected';
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

/**
 * Parses the ExitPlanMode result content string to recover the approval outcome
 * and optional plan path. Core-side templates live in
 * `packages/agent-core/src/tools/builtin/planning/exit-plan-mode.ts`:
 *   - Approved output starts with 'Exited plan mode.' and selected options
 *     are reported as 'Selected approach: <label>'. Older outputs may start
 *     with 'User approved option "<label>".' Plan-file mode may include
 *     'Plan saved to: <path>'.
 *   - Rejected output starts with 'Plan rejected by user.' or older
 *     'User rejected the plan.'; feedback uses 'User rejected the plan.
 *     Feedback:\n\n<text>'.
 * This is a string protocol rather than a structured payload. Prefer a
 * structured event payload if core starts emitting one.
 */
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
  const optionMatch = SELECTED_APPROACH_RE.exec(output) ?? APPROVED_OPTION_RE.exec(output);
  if (optionMatch !== null) {
    return path !== undefined && path.length > 0
      ? { kind: 'approved', chosen: optionMatch[1], path }
      : { kind: 'approved', chosen: optionMatch[1] };
  }
  return path !== undefined && path.length > 0 ? { kind: 'approved', path } : { kind: 'approved' };
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

/**
 * Pull the live value of a JSON string field out of partially-streamed
 * arguments, even if the closing quote hasn't arrived yet. Handles the
 * common JSON string escapes so `\n` in a streamed `content` becomes a
 * real newline we can highlight. Returns `undefined` if the field hasn't
 * started streaming yet.
 */
function extractPartialStringField(text: string, key: string): string | undefined {
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
    } catch {
      // fall through to partial scan
    }
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
    // Preserve the tail (filename) — drop the prefix so the user can
    // still tell which file is being touched.
    return '…' + value.slice(value.length - (MAX_ARG_LENGTH - 1));
  }
  return value.slice(0, MAX_ARG_LENGTH - 3) + '...';
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

function formatKeyArgument(
  toolName: string,
  key: string,
  value: string,
  workspaceDir: string | undefined,
): string {
  const displayValue =
    toolName === 'Read' && PATH_KEYS.has(key)
      ? makeWorkspaceRelativePath(value, workspaceDir)
      : value;
  return truncateArgValue(key, displayValue);
}

function extractKeyArgument(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string | null {
  const keyMap: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['path', 'file_path'],
    Write: ['path', 'file_path'],
    Edit: ['path', 'file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    FetchURL: ['url'],
    WebSearch: ['query'],
    // Prefer the short `description` so the header preview never spills a
    // multi-line `prompt` into the TUI chrome.
    Agent: ['description', 'prompt'],
  };

  const candidates = keyMap[toolName] ?? Object.keys(args);
  for (const key of candidates) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      const firstLine = val.split('\n')[0] ?? val;
      return formatKeyArgument(toolName, key, firstLine, workspaceDir);
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
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines);
}

class PrefixedWrappedLine implements Component {
  constructor(
    private readonly firstPrefix: string,
    private readonly continuationPrefix: string,
    private readonly text: string,
  ) { }

  invalidate(): void { }

  render(width: number): string[] {
    const prefixWidth = Math.max(
      visibleWidth(this.firstPrefix),
      visibleWidth(this.continuationPrefix),
    );
    const contentWidth = Math.max(1, width - prefixWidth);
    const lines = new Text(this.text, 0, 0).render(contentWidth);
    return lines.map((line, index) =>
      index === 0 ? `${this.firstPrefix}${line}` : `${this.continuationPrefix}${line}`,
    );
  }
}

export class ToolCallComponent extends Container {
  private expanded = false;
  private planExpanded = false;
  private toolCall: ToolCallBlockData;
  private result: ToolResultBlockData | undefined;
  private colors: ColorPalette;
  private ui: TUI | undefined;
  private markdownTheme: MarkdownTheme | undefined;
  private planPath: string | undefined;
  /**
   * Fallback plan body used when the LLM uses plan-file mode and
   * `args.plan` is empty. `KimiTUI` calls `setPlanInfo` with
   * `session.getPlan()` content so the plan box can render while
   * approval is pending, and so rejected or revised results still show
   * the plan body even without a `## Approved Plan:` marker.
   */
  private currentPlan: string | undefined;
  private headerText: Text;
  private callPreviewEndIndex = 0;

  // ── Subagent state ───────────────────────────────────────────────
  //
  // Populated by `setSubagentMeta` / `appendSubToolCall` / `finishSubToolCall`
  // when KimiTUI routes a `subagent.event` with this tool call
  // id as its `parent_tool_call_id`. Rendered at the tail of
  // buildContent so it shows up both during streaming and after the
  // parent tool call resolves.
  private subagentAgentId: string | undefined;
  private subagentAgentName: string | undefined;
  private readonly ongoingSubCalls = new Map<string, OngoingSubCall>();
  private readonly finishedSubCalls: FinishedSubCall[] = [];
  private readonly subToolActivities = new Map<string, SubToolActivity>();
  private subToolOrderSeq = 0;
  private hiddenSubCallCount = 0;
  /**
   * Recent normal-output lines from the child agent. Historical replay can also
   * store mixed text here.
   */
  private subagentText = '';
  private subagentThinkingText = '';
  // ── Subagent lifecycle state from subagent.spawned/completed/failed ──
  private subagentPhase: 'spawning' | 'running' | 'done' | 'failed' | 'backgrounded' | undefined;
  private subagentUsage: SubagentTokenUsage | undefined;
  private subagentResultSummary: string | undefined;
  private subagentError: string | undefined;
  private streamingProgressTimer: ReturnType<typeof setInterval> | undefined;
  private subagentElapsedTimer: ReturnType<typeof setInterval> | undefined;
  private subagentStartedAtMs: number | undefined;
  private subagentEndedAtMs: number | undefined;

  // ── Live progress lines ──────────────────────────────────────────
  //
  // Populated by `appendProgress` whenever the tool emits an
  // `onUpdate({kind:'status', text})` while still running. Used by
  // long-blocking tools (e.g. the MCP `authenticate` synthetic tool
  // whose 15-minute browser wait would otherwise display only a
  // spinner). Cleared when the result lands — the result is the
  // authoritative final state.
  private progressLines: string[] = [];
  private static readonly MAX_PROGRESS_LINES = 24;

  /**
   * Registered by a group container (`AgentGroupComponent` or
   * `ReadGroupComponent`) when this component is borrowed as a hidden state
   * container. Any state change (subagent meta, phase, sub-tool, result, etc.)
   * triggers a throttled group re-render. `undefined` means no group is
   * subscribed and standalone rendering is unaffected. A ToolCallComponent can
   * only belong to one group at a time, so one listener slot is enough.
   */
  private onSnapshotChange: (() => void) | undefined;

  constructor(
    toolCall: ToolCallBlockData,
    result: ToolResultBlockData | undefined,
    colors: ColorPalette,
    ui?: TUI,
    markdownTheme?: MarkdownTheme,
    private readonly workspaceDir?: string,
  ) {
    super();
    this.toolCall = toolCall;
    this.result = result;
    this.colors = colors;
    this.ui = ui;
    this.markdownTheme = markdownTheme;
    this.applySubagentReplay(toolCall.subagent);

    this.addChild(new Spacer(1));
    this.headerText = new Text(this.buildHeader(), 0, 0);
    this.addChild(this.headerText);
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildProgressBlock();
    this.buildContent();
    this.buildSubagentBlock();
    this.syncStreamingProgressTimer();
    this.syncSubagentElapsedTimer();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    // rebuildBody (not rebuildContent) so the args-driven call preview
    // — which is what carries Write content / Edit diff — re-renders
    // with the new line cap. rebuildContent only touches result-driven
    // children and would leave the call preview stuck at its initial
    // collapsed size.
    this.rebuildBody();
  }

  // Toggle the plan box's expanded state independently from tool-output
  // expansion. Returns true iff this card actually owns a plan preview
  // (ExitPlanMode), so the caller can decide whether to consume the keystroke.
  setPlanExpanded(expanded: boolean): boolean {
    if (this.toolCall.name !== 'ExitPlanMode') return false;
    if (this.planExpanded === expanded) return true;
    this.planExpanded = expanded;
    this.rebuildBody();
    return true;
  }

  setResult(result: ToolResultBlockData): void {
    this.result = result;
    // Result supersedes any live progress chatter; the result body is the
    // authoritative final state. Without this clear, a finished tool would
    // show both the streamed status lines and the final output stacked.
    this.progressLines = [];
    this.finalizeSubagentElapsedIfNeeded();
    this.syncStreamingProgressTimer();
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    // rebuildBody (not rebuildContent) so the call preview re-renders
    // with the collapsed cap applied — Write streaming previews and
    // Edit's progress placeholder needs to snap to the final preview on
    // result.
    this.rebuildBody();
    // Final results affect group summaries, especially failed/done counts.
    this.notifySnapshotChange();
  }

  updateToolCall(toolCall: ToolCallBlockData): void {
    this.toolCall = toolCall;
    this.syncStreamingProgressTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /**
   * Append a live progress line emitted by the tool via
   * `onUpdate({kind:'status', text})`. Splits on newlines so multi-line
   * status payloads render row-by-row. Old lines are dropped once the
   * buffer fills past {@link ToolCallComponent.MAX_PROGRESS_LINES} so a
   * misbehaving tool can't grow the box unboundedly.
   */
  appendProgress(text: string): void {
    if (this.result !== undefined) return;
    for (const line of text.split('\n')) {
      this.progressLines.push(line);
    }
    while (this.progressLines.length > ToolCallComponent.MAX_PROGRESS_LINES) {
      this.progressLines.shift();
    }
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  dispose(): void {
    this.stopStreamingProgressTimer();
    this.stopSubagentElapsedTimer();
  }

  /**
   * Injects plan body/path asynchronously. Only ExitPlanMode cards use
   * this: plan-file mode leaves `args.plan` empty, so `KimiTUI` fetches
   * the plan via `session.getPlan()` and calls this method to render the
   * plan box.
   */
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
    this.subagentText = subagent.text ?? '';
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
      );
    }
    while (this.finishedSubCalls.length > MAX_SUB_TOOL_CALLS_SHOWN) {
      this.finishedSubCalls.shift();
      this.hiddenSubCallCount += 1;
    }
  }

  // ── Subagent API (called by KimiTUI event routing) ───────────────

  setSubagentMeta(agentId: string, agentName?: string): void {
    if (this.subagentAgentId === agentId && this.subagentAgentName === agentName) return;
    this.subagentAgentId = agentId;
    this.subagentAgentName = agentName;
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /**
   * Lets group containers (AgentGroup or ReadGroup) subscribe to this card's
   * state changes. Registration immediately calls back so the group receives
   * the current snapshot without separately calling getSubagentSnapshot or
   * getReadSnapshot. Pass `undefined` to unsubscribe.
   */
  setSnapshotListener(cb: (() => void) | undefined): void {
    this.onSnapshotChange = cb;
    if (cb !== undefined) cb();
  }

  getSubagentSnapshot(): ToolCallSubagentSnapshot {
    const finished = this.finishedSubCalls.length + this.hiddenSubCallCount;
    const tokens =
      this.subagentUsage === undefined
        ? 0
        : usageInputTotal(this.subagentUsage) + this.subagentUsage.output;
    const latestActivity = computeLatestActivity(
      this.ongoingSubCalls,
      this.finishedSubCalls,
      this.getCombinedSubagentText(),
      this.workspaceDir,
    );
    // Terminal-state priority: SDK `tool.result` is authoritative for Agent
    // tool calls. Once it arrives, force done/failed over intermediate
    // spawning/running states for two reasons:
    //   1. Replay does not replay spawned/completed/failed events, so
    //      `subagentPhase` stays undefined and result must be used.
    //   2. Live type-validation failures may skip `subagent.failed`, or
    //      `tool.result` may arrive first; otherwise the UI can stay stuck at
    //      'spawning' and keep showing `Initializing...`.
    // Intermediate states without a result still use `subagentPhase`.
    // `backgrounded` has no result because background agents do not enter the
    // transcript.
    const derivedPhase: ToolCallSubagentSnapshot['phase'] =
      this.result !== undefined ? (this.result.is_error ? 'failed' : 'done') : this.subagentPhase;
    return {
      toolCallId: this.toolCall.id,
      toolName: this.toolCall.name,
      toolCallDescription: str(this.toolCall.args['description']) || str(this.toolCall.description),
      agentName: this.subagentAgentName,
      phase: derivedPhase,
      toolCount: finished,
      tokens,
      isError: derivedPhase === 'failed',
      errorText:
        this.subagentError ?? (derivedPhase === 'failed' ? this.result?.output : undefined),
      latestActivity,
    };
  }

  /**
   * Used by `ReadGroupComponent` to sum line counts across same-step Read
   * cards. `lines` matches the single-card chip
   * (`pluralize(countNonEmptyLines(...), 'line')`) so group and card counts do
   * not drift.
   */
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

  // Readonly view for group access to toolCall metadata (id, name, description).
  get toolCallView(): Readonly<ToolCallBlockData> {
    return this.toolCall;
  }

  /** Notifies the listener when internal state changes, if a group is attached. */
  private notifySnapshotChange(): void {
    this.onSnapshotChange?.();
  }

  private upsertSubToolActivity(
    id: string,
    name: string,
    args: Record<string, unknown>,
    phase: SubToolActivity['phase'],
  ): void {
    const existing = this.subToolActivities.get(id);
    if (existing !== undefined) {
      existing.name = name;
      existing.args = args;
      existing.phase = phase;
      return;
    }
    this.subToolActivities.set(id, {
      id,
      name,
      args,
      phase,
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

  private syncSubagentElapsedTimer(): void {
    const phase = this.getDerivedSubagentPhase();
    const shouldTick =
      this.isSingleSubagentView() &&
      this.subagentStartedAtMs !== undefined &&
      (phase === 'spawning' || phase === 'running');
    if (!shouldTick) {
      this.stopSubagentElapsedTimer();
      return;
    }
    if (this.ui === undefined || this.subagentElapsedTimer !== undefined) return;
    this.subagentElapsedTimer = setInterval(() => {
      const latestPhase = this.getDerivedSubagentPhase();
      if (latestPhase !== 'spawning' && latestPhase !== 'running') {
        this.stopSubagentElapsedTimer();
        return;
      }
      this.headerText.setText(this.buildHeader());
      this.invalidate();
      this.ui?.requestRender();
    }, SUBAGENT_ELAPSED_INTERVAL_MS);
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

  /**
   * Handles SDK `subagent.spawned`. The child agent is registered, but internal
   * activity events (`assistant.delta` or `tool.call.started`) may not have
   * arrived yet, so the UI moves to the 'spawning' placeholder state unless the
   * agent is running in the background.
   */
  onSubagentSpawned(meta: {
    agentId: string;
    agentName?: string | undefined;
    runInBackground: boolean;
  }): void {
    this.subagentAgentId = meta.agentId;
    this.subagentAgentName = meta.agentName;
    this.subagentPhase = meta.runInBackground ? 'backgrounded' : 'spawning';
    this.subagentStartedAtMs = Date.now();
    this.subagentEndedAtMs = undefined;
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /**
   * Handles SDK `subagent.completed`. Moves the phase to 'done' and records
   * token usage plus the result summary for the header chip and tail summary.
   */
  onSubagentCompleted(payload: {
    usage?: SubagentTokenUsage | undefined;
    resultSummary: string;
  }): void {
    this.subagentPhase = 'done';
    this.subagentEndedAtMs ??= Date.now();
    this.subagentUsage = payload.usage;
    this.subagentResultSummary =
      payload.resultSummary.length > 0 ? payload.resultSummary : undefined;
    if (this.subagentText.trim().length === 0 && this.subagentResultSummary !== undefined) {
      this.subagentText = this.subagentResultSummary;
    }
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  /** Handles SDK `subagent.failed`. */
  onSubagentFailed(payload: { error: string }): void {
    this.subagentPhase = 'failed';
    this.subagentEndedAtMs ??= Date.now();
    this.subagentError = payload.error;
    this.syncSubagentElapsedTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendSubagentText(text: string, kind: SubagentTextKind = 'text'): void {
    if (kind === 'thinking') {
      this.subagentThinkingText += text;
    } else {
      this.subagentText += text;
    }
    // Child-agent activity means it is running unless already terminal/backgrounded.
    if (this.subagentPhase === undefined || this.subagentPhase === 'spawning') {
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
    if (this.subagentPhase === undefined || this.subagentPhase === 'spawning') {
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
    this.headerText.setText(this.buildHeader());
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

  private buildHeader(): string {
    const { toolCall, result, colors } = this;
    const isFinished = result !== undefined;
    const isError = result?.is_error ?? false;
    const isTruncated = toolCall.truncated === true && !isFinished;

    let bullet: string;
    if (isFinished) {
      bullet = isError ? chalk.hex(colors.error)('✗ ') : chalk.hex(colors.success)(STATUS_BULLET);
    } else if (isTruncated) {
      bullet = chalk.hex(colors.error)('✗ ');
    } else {
      // Solid bullet for in-flight tools — the previous marker ↔ blank
      // toggle caused visible flicker on every re-render.
      bullet = chalk.hex(colors.roleAssistant)(STATUS_BULLET);
    }

    if (toolCall.name === 'ExitPlanMode') {
      const label = chalk.hex(colors.primary).bold('Current plan');
      if (!isFinished || result === undefined || result.is_error === true) {
        return label;
      }
      const outcome = interpretExitPlanModeOutcome(result.output);
      if (outcome.kind === 'approved') {
        const chipText =
          outcome.chosen !== undefined && outcome.chosen.length > 0
            ? `Approved: ${outcome.chosen}`
            : 'Approved';
        return `${label}${chalk.hex(colors.success)(` · ${chipText}`)}`;
      }
      return `${label}${chalk.hex(colors.error)(' · Rejected')}`;
    }

    if (toolCall.name === 'AskUserQuestion') {
      const label = isFinished
        ? isError
          ? 'Could not collect your input'
          : 'Collected your answers'
        : 'Waiting for your input';
      const tone = isError ? chalk.hex(colors.error) : chalk.hex(colors.primary);
      return `${bullet}${tone.bold(label)}`;
    }

    if (this.isSingleSubagentView()) {
      return this.buildSingleSubagentHeader();
    }

    const verb = isFinished ? 'Used' : isTruncated ? 'Truncated' : 'Using';
    const keyArg = extractKeyArgument(toolCall.name, toolCall.args, this.workspaceDir);
    const decoded = decodeMcpToolName(toolCall.name);
    const verbStyled = isTruncated
      ? chalk.hex(colors.error)(verb)
      : verb;
    const toolLabel =
      decoded !== null
        ? `${chalk.hex(colors.primary).bold(decoded.toolName)}${chalk.dim(` · MCP/${decoded.serverName}`)}`
        : chalk.hex(colors.primary).bold(toolCall.name);
    const argStr = keyArg ? chalk.dim(` (${keyArg})`) : '';
    let chipStr = '';
    if (isFinished && result) chipStr = this.buildHeaderChip(result);
    return `${bullet}${verbStyled} ${toolLabel}${argStr}${chipStr}`;
  }

  private buildHeaderChip(result: ToolResultBlockData): string {
    const provider = pickChip(this.toolCall.name);
    if (provider === undefined) return '';
    const text = provider(this.toolCall, result);
    if (text.length === 0) return '';
    const tone = result.is_error ? chalk.hex(this.colors.error) : chalk.dim;
    return tone(` · ${text}`);
  }

  private rebuildContent(): void {
    while (this.children.length > this.callPreviewEndIndex) {
      this.children.pop();
    }
    this.buildProgressBlock();
    this.buildContent();
    this.buildSubagentBlock();
  }

  private rebuildBody(): void {
    while (this.children.length > 2) {
      this.children.pop();
    }
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildProgressBlock();
    this.buildContent();
    this.buildSubagentBlock();
  }

  /**
   * Render the accumulated `progressLines` between the call preview and
   * the result body. URLs inside a line are wrapped in an OSC 8 hyperlink
   * sequence so terminals that support it (iTerm2, Ghostty, kitty, modern
   * Terminal.app, VS Code) make the URL Cmd-clickable and expose
   * "Copy Link" via the context menu — even when pi-tui soft-wraps the
   * URL across multiple rows (pi-tui's wrapTextWithAnsi re-opens the
   * active OSC 8 link on each continuation line). Each embedded URL is
   * styled individually so surrounding prose keeps its default dim tone.
   */
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
          const visible = chalk.hex(this.colors.warning).underline(url);
          return `\u001B]8;;${url}\u001B\\${visible}\u001B]8;;\u001B\\`;
        })
        : chalk.dim(raw);
      PROGRESS_URL_RE.lastIndex = 0;
      this.addChild(new Text(styled, 2, 0));
    }
  }

  private buildSubagentBlock(): void {
    if (
      this.subagentAgentId === undefined &&
      this.ongoingSubCalls.size === 0 &&
      this.finishedSubCalls.length === 0 &&
      this.subagentText.length === 0 &&
      this.subagentPhase === undefined
    ) {
      return;
    }

    if (this.isSingleSubagentView()) {
      this.buildSingleSubagentBlock();
      return;
    }

    const dim = chalk.dim;
    const phaseChip = this.formatPhaseChip();
    const headerLabel =
      this.subagentAgentName !== undefined
        ? `subagent ${this.subagentAgentName} (${this.formatAgentId()})`
        : `subagent (${this.formatAgentId()})`;
    this.addChild(new Text(`  ${dim(`↳ ${headerLabel}`)}${phaseChip}`, 0, 0));

    if (this.hiddenSubCallCount > 0) {
      const suffix = this.hiddenSubCallCount > 1 ? 's' : '';
      this.addChild(
        new Text(
          dim.italic(`    ${String(this.hiddenSubCallCount)} more tool call${suffix} ...`),
          0,
          0,
        ),
      );
    }

    for (const sub of this.finishedSubCalls) {
      const mark = sub.isError
        ? chalk.hex(this.colors.error)('✗')
        : chalk.hex(this.colors.success)('•');
      const keyArg = extractKeyArgument(sub.name, sub.args, this.workspaceDir);
      const nameCol = chalk.hex(this.colors.primary)(sub.name);
      const argCol = keyArg ? dim(` (${keyArg})`) : '';
      this.addChild(new Text(`    ${mark} Used ${nameCol}${argCol}`, 0, 0));
    }

    for (const [id, call] of this.ongoingSubCalls) {
      const keyArg = extractKeyArgument(call.name, call.args, this.workspaceDir);
      const nameCol = chalk.hex(this.colors.primary)(call.name);
      const argCol = keyArg ? dim(` (${keyArg})`) : '';
      void id;
      this.addChild(new Text(`    ${dim('…')} Using ${nameCol}${argCol}`, 0, 0));
    }

    if (this.subagentText.length > 0) {
      const tailLines = this.subagentText.split('\n').slice(-3);
      for (const line of tailLines) {
        this.addChild(new Text(`    ${dim(line)}`, 0, 0));
      }
    }

    // Result summary from subagent.completed.
    if (this.subagentPhase === 'done' && this.subagentResultSummary !== undefined) {
      const summaryLines = this.subagentResultSummary.split('\n').slice(0, 2);
      for (const line of summaryLines) {
        this.addChild(new Text(`    ${dim('└')} ${line}`, 0, 0));
      }
    }

    // Full error text from subagent.failed; do not collapse it.
    if (this.subagentPhase === 'failed' && this.subagentError !== undefined) {
      const errLines = this.subagentError.split('\n');
      for (const line of errLines) {
        this.addChild(new Text(`    ${chalk.hex(this.colors.error)('└')} ${line}`, 0, 0));
      }
    }
  }

  /**
   * Header phase/token chip. No chip is shown when phase is undefined.
   *   spawning      -> starting
   *   running       -> running
   *   done          -> N tools, 8.4k tok
   *   failed        -> failed
   *   backgrounded  -> backgrounded
   */
  private formatPhaseChip(): string {
    if (this.subagentPhase === undefined) return '';
    const dim = chalk.dim;
    const parts: string[] = [];
    switch (this.subagentPhase) {
      case 'spawning':
        parts.push('↻ starting…');
        break;
      case 'running':
        parts.push('↻ running');
        break;
      case 'done': {
        parts.push(chalk.hex(this.colors.success)('✓ done'));
        const toolCount = this.finishedSubCalls.length + this.hiddenSubCallCount;
        if (toolCount > 0) parts.push(`${String(toolCount)} tool${toolCount > 1 ? 's' : ''}`);
        const tokens = formatSubagentTokens(this.subagentUsage);
        if (tokens !== undefined) parts.push(tokens);
        break;
      }
      case 'failed':
        parts.push(chalk.hex(this.colors.error)('✗ failed'));
        break;
      case 'backgrounded':
        parts.push('◐ backgrounded');
        break;
    }
    return parts.length > 0 ? dim(` · ${parts.join(' · ')}`) : '';
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
      this.subagentPhase !== undefined
    );
  }

  private isSingleSubagentView(): boolean {
    return this.toolCall.name === 'Agent' && this.hasSubagentState();
  }

  private getDerivedSubagentPhase():
    | 'spawning'
    | 'running'
    | 'done'
    | 'failed'
    | 'backgrounded'
    | undefined {
    if (this.result !== undefined) return this.result.is_error ? 'failed' : 'done';
    return this.subagentPhase;
  }

  private buildSingleSubagentHeader(): string {
    const phase = this.getDerivedSubagentPhase();
    const isFailed = phase === 'failed';
    const isDone = phase === 'done';
    const bullet = isFailed
      ? chalk.hex(this.colors.error)('✗ ')
      : isDone
        ? chalk.hex(this.colors.success)(STATUS_BULLET)
        : chalk.hex(this.colors.roleAssistant)(STATUS_BULLET);
    const labelText = formatSubagentLabel(this.subagentAgentName);
    const label = chalk.hex(this.colors.primary).bold(labelText);
    const status = this.formatSingleSubagentStatus(phase);
    const description = str(this.toolCall.args['description']);
    const descriptionPlain = description.length > 0 ? ` (${description})` : '';
    const descriptionText = descriptionPlain.length > 0 ? chalk.dim(descriptionPlain) : '';
    const statsText = this.formatSingleSubagentStatsText();
    if (isDone) {
      const success = chalk.hex(this.colors.success);
      return `${bullet}${success.bold(labelText)} ${success(`Completed${descriptionPlain}${statsText}`)}`;
    }
    const stats = chalk.dim(statsText);
    return `${bullet}${label} ${status}${descriptionText}${stats}`;
  }

  private formatSingleSubagentStatus(
    phase: 'spawning' | 'running' | 'done' | 'failed' | 'backgrounded' | undefined,
  ): string {
    switch (phase) {
      case 'done':
        return chalk.hex(this.colors.success)('Completed');
      case 'failed':
        return chalk.hex(this.colors.error)('Failed');
      case 'running':
        return chalk.hex(this.colors.primary)('Running');
      case 'backgrounded':
        return 'Backgrounded';
      case 'spawning':
      case undefined:
        return chalk.hex(this.colors.primary)('Starting');
    }
  }

  private formatSingleSubagentStatsText(): string {
    const parts = [
      `${String(this.subToolActivities.size)} tool${this.subToolActivities.size === 1 ? '' : 's'}`,
    ];
    const elapsed = this.getSubagentElapsedSeconds();
    if (elapsed !== undefined) parts.push(formatElapsed(elapsed));
    return ` · ${parts.join(' · ')}`;
  }

  private getSubagentElapsedSeconds(): number | undefined {
    if (this.subagentStartedAtMs === undefined) return undefined;
    const end = this.subagentEndedAtMs ?? Date.now();
    return Math.max(0, Math.floor((end - this.subagentStartedAtMs) / 1000));
  }

  private buildSingleSubagentBlock(): void {
    for (const activity of this.getRecentSubToolActivities()) {
      const mark =
        activity.phase === 'failed'
          ? chalk.hex(this.colors.error)('✗')
          : activity.phase === 'done'
            ? chalk.hex(this.colors.success)('•')
            : chalk.hex(this.colors.text)('•');
      const verb = activity.phase === 'ongoing' ? 'Using' : 'Used';
      this.addChild(new Text(`  ${mark} ${this.formatSubToolActivity(verb, activity)}`, 0, 0));
    }

    if (this.getDerivedSubagentPhase() === 'failed' && this.subagentError !== undefined) {
      const errorLine = tailNonEmptyLines(this.subagentError, 1).at(-1);
      if (errorLine !== undefined) {
        this.addChild(
          new PrefixedWrappedLine(
            `  ${chalk.hex(this.colors.error)('└')} `,
            '    ',
            chalk.hex(this.colors.error)(errorLine),
          ),
        );
      }
      return;
    }

    const outputLine = tailNonEmptyLines(this.subagentText, 1).at(-1);
    const thinkingLine = tailNonEmptyLines(this.subagentThinkingText, 1).at(-1);
    if (this.getDerivedSubagentPhase() !== 'done' && thinkingLine !== undefined) {
      this.addChild(
        new PrefixedWrappedLine(`  ${chalk.dim('◌')} `, '    ', chalk.dim(thinkingLine)),
      );
    }
    if (outputLine !== undefined) {
      this.addChild(
        new PrefixedWrappedLine(
          `  ${chalk.hex(this.colors.text)('└')} `,
          '    ',
          chalk.hex(this.colors.text)(outputLine),
        ),
      );
    }
  }

  private getRecentSubToolActivities(): SubToolActivity[] {
    return [...this.subToolActivities.values()]
      .toSorted((a, b) => a.orderSeq - b.orderSeq)
      .slice(-MAX_SINGLE_SUBAGENT_TOOL_ROWS);
  }

  private formatSubToolActivity(verb: string, activity: SubToolActivity): string {
    const keyArg = extractKeyArgument(activity.name, activity.args, this.workspaceDir);
    const nameCol = chalk.hex(this.colors.primary)(activity.name);
    const argCol = keyArg ? chalk.dim(` (${keyArg})`) : '';
    return `${verb} ${nameCol}${argCol}`;
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
          chalk.dim('Tool call arguments truncated by max_tokens — call never executed.'),
          2,
          0,
        ),
      );
      return;
    }
    if (this.result === undefined && this.toolCall.streamingArguments !== undefined) {
      this.buildStreamingPreview(this.toolCall.streamingArguments);
      return;
    }
    const shouldCap = this.result !== undefined && !this.expanded;
    if (name === 'Write') {
      const content = str(this.toolCall.args['content']);
      if (content.length === 0) return;
      const filePath = str(this.toolCall.args['file_path'] ?? this.toolCall.args['path']);
      const lang = langFromPath(filePath);
      const allLines = highlightLines(content, lang);
      // Cap as soon as args finalize, not just when result lands. Otherwise the
      // brief render tick between finalized args and result draws the full file,
      // and the snap back to the collapsed cap triggers pi-tui's full-redraw
      // path which wipes the terminal scrollback (pre-TUI history).
      const writeShouldCap = !this.expanded;
      const shown = writeShouldCap ? allLines.slice(0, COMMAND_PREVIEW_LINES) : allLines;
      const remaining = allLines.length - shown.length;
      for (const [i, line] of shown.entries()) {
        const lineNum = chalk.dim(String(i + 1).padStart(4) + '  ');
        this.addChild(new Text(lineNum + line, 2, 0));
      }
      if (writeShouldCap && remaining > 0) {
        this.addChild(
          new Text(
            chalk.dim(
              `... (${String(remaining)} more lines, ${String(allLines.length)} total, ctrl+o to expand)`,
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
      const lines = renderDiffLinesClustered(oldStr, newStr, filePath, this.colors, {
        contextLines: 3,
        ...(shouldCap ? { maxLines: COMMAND_PREVIEW_LINES } : {}),
      });
      for (const line of lines) {
        this.addChild(new Text(line, 2, 0));
      }
    }
  }

  /**
   * Live-rendering during the `tool.call.delta` streaming window.
   *
   * For tools we recognise, we reach into the partial JSON (via
   * `extractPartialStringField`) and render a stable high-signal
   * preview: Write's `content` as highlighted code, Edit's argument
   * receive progress, Bash's `$ command`, etc. While args are still
   * streaming we render from a bounded preview buffer; once the result lands,
   * the preview snaps to the collapsed cap unless the user has expanded.
   */
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
        const lineNum = chalk.dim(String(originalLineNumber + 1).padStart(4) + '  ');
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
      this.addChild(new Text(chalk.dim(progress), 2, 0));
      return;
    }
    if (name === 'Bash') {
      const cmd = extractPartialStringField(previewText, 'command');
      if (cmd === undefined || cmd.length === 0) return;
      this.addChild(
        new ShellExecutionComponent({
          command: cmd,
          colors: this.colors,
          showCommand: true,
          commandPreviewLines: COMMAND_PREVIEW_LINES,
        }),
      );
    }
    // Unknown tools: nothing sensible to stream without a schema, so
    // leave the body blank and let the header do the talking.
  }

  private buildPlanPreview(): void {
    // Priority: inline `args.plan`, approved plan parsed from result, then
    // asynchronously injected currentPlan used while approval is in flight.
    // Once a plan is found, PlanBoxComponent renders it. Without markdownTheme
    // (unit tests), fall back to indented dim text so it remains visible.
    const plan = this.resolvePlanForPreview();
    if (plan.length === 0) return;
    const path = this.resolvePlanPath();
    if (this.markdownTheme !== undefined) {
      this.addChild(
        new PlanBoxComponent(plan, this.markdownTheme, this.colors.success, path, {
          maxContentLines: this.computePlanBoxMaxContentLines(),
          expanded: this.planExpanded,
        }),
      );
    } else {
      this.addChild(new Text(chalk.dim(plan), 2, 0));
    }
  }

  private computePlanBoxMaxContentLines(): number | undefined {
    const rows = this.ui?.terminal.rows;
    if (rows === undefined || !Number.isFinite(rows) || rows <= 0) return undefined;
    return Math.max(8, Math.floor(rows * 0.6) - 4);
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

  // Priority: approved result.output with 'Plan saved to: <path>', then the
  // planPath asynchronously injected by setPlanInfo while approval is in flight.
  private resolvePlanPath(): string | undefined {
    if (this.result !== undefined && !this.result.is_error) {
      const fromResult = interpretExitPlanModeOutcome(this.result.output).path;
      if (fromResult !== undefined && fromResult.length > 0) return fromResult;
    }
    return this.planPath;
  }

  private buildContent(): void {
    const { result } = this;
    if (result === undefined || !result.output) return;

    if (this.isSingleSubagentView()) {
      return;
    }

    // Outputs that start with a `<system…>` tag are harness-injected
    // reminders piggy-backing on a tool result. They are noise for the
    // user, so suppress the body while keeping the header chip intact.
    if (result.output.trimStart().startsWith('<system')) {
      return;
    }

    if (this.toolCall.name === 'ExitPlanMode' && !result.is_error) {
      // Approved plans are already rendered by buildCallPreview via
      // resolvePlanForPreview. Rejected or revise feedback uses a warning label
      // plus normal body text so it remains visible in the transcript.
      const outcome = interpretExitPlanModeOutcome(result.output);
      if (outcome.kind === 'rejected' && outcome.feedback !== undefined) {
        const trimmed = outcome.feedback.trim();
        if (trimmed.length > 0) {
          const labelTone = chalk.hex(this.colors.warning).bold;
          this.addChild(new Text(labelTone('↪ Suggestion'), 2, 0));
          for (const line of trimmed.split('\n')) {
            this.addChild(new Text(line, 4, 0));
          }
        }
      }
      return;
    }

    // TodoList: the authoritative list is shown in the dedicated
    // TodoPanel before the input area, so repeating the text dump here is
    // pure clutter. Keep the headline, drop the body.
    if (this.toolCall.name === 'TodoList' && !result.is_error) {
      return;
    }

    if (this.toolCall.name === 'EnterPlanMode' && !result.is_error) {
      return;
    }

    if (
      this.toolCall.name === 'AskUserQuestion' &&
      !result.is_error &&
      this.renderAskUserQuestionResult(result.output)
    ) {
      return;
    }

    const renderer = pickResultRenderer(this.toolCall.name);
    const components = renderer(this.toolCall, result, {
      expanded: this.expanded,
      colors: this.colors,
    });
    for (const component of components) {
      this.addChild(component);
    }
  }

  /**
   * Render AskUserQuestion's JSON payload as a friendly Q/A list.
   * Returns true on success (caller skips the default JSON dump);
   * false on parse failure (caller falls back to raw display).
   */
  private renderAskUserQuestionResult(output: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed === null) return false;

    const colors = this.colors;
    const dim = chalk.dim;
    const accent = chalk.hex(colors.primary);

    const answers = (parsed as { answers?: unknown }).answers;
    const note = (parsed as { note?: unknown }).note;

    const hasAnswers =
      typeof answers === 'object' && answers !== null && Object.keys(answers).length > 0;

    if (!hasAnswers) {
      const noteText =
        typeof note === 'string' && note.length > 0 ? note : 'User dismissed the question.';
      this.addChild(new Text(dim(`  ${noteText}`), 0, 0));
      return true;
    }

    for (const [question, answer] of Object.entries(answers as Record<string, unknown>)) {
      const answerText = typeof answer === 'string' ? answer : JSON.stringify(answer);
      this.addChild(new Text(`  ${dim('Q')}  ${question}`, 0, 0));
      this.addChild(new Text(`  ${accent('→')}  ${answerText}`, 0, 0));
    }
    return true;
  }
}

/**
 * Computes the second-level "latest activity" line for group rows:
 *   1. latest ongoing sub-tool (`Using {name} ({keyArg})`)
 *   2. latest finished sub-tool (`Used {name} ({keyArg})`)
 *   3. last non-empty line from accumulated subagent text
 */
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
    const tail = text
      .split('\n')
      .toReversed()
      .find((l) => l.trim().length > 0);
    if (tail !== undefined) return tail.trim();
  }
  return undefined;
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
