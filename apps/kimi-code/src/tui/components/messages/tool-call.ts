/**
 * Renders a tool call entry in the transcript.
 * Supports expand/collapse via Ctrl+O.
 *
 * Architecture: this component is a coordinator that delegates to
 * extracted modules under ./tool-call/:
 *   - SubagentStateManager: subagent lifecycle, sub-tool tracking, snapshots
 *   - formatters: pure formatting helpers (tokens, elapsed, key args, etc.)
 *   - plan-mode: ExitPlanMode result parsing
 *   - streaming-preview: partial JSON field extraction for live previews
 *   - prefixed-wrapped-line: wrapping text component for subagent windows
 */

import { Container, Spacer, Text, type Component, type TUI } from '@moonshot-ai/pi-tui';
import {
  BRAILLE_SPINNER_FRAMES,
  RESULT_PREVIEW_LINES,
  THINKING_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import { decodeMcpToolName } from '#/tui/utils/mcp-tool-name';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { t } from '#/i18n';

import { ShellExecutionComponent } from './shell-execution';
import { pickChip } from './tool-renderers/chip';
import { buildGoalToolHeader } from './tool-renderers/goal';
import { isGenericToolResult } from './tool-renderers/registry';

// Extracted modules
import { buildCallPreview } from './tool-call/call-preview';
import {
  formatElapsed,
  formatSubagentLabel,
  formatTokens,
  extractKeyArgument,
  str,
  tailNonEmptyLines,
  usageTotal,
} from './tool-call/formatters';
import { interpretExitPlanModeOutcome } from './tool-call/plan-mode';
import { PrefixedWrappedLine } from './tool-call/prefixed-wrapped-line';
import { buildResultContent } from './tool-call/result-content';
import { SubagentStateManager } from './tool-call/subagent-state';
import type {
  SubagentCompletedPayload,
  SubagentFailedPayload,
  SubagentMetricsPayload,
  SubagentPhase,
  SubagentSpawnedMeta,
  SubagentStartedMeta,
  SubToolActivity,
  ToolCallReadSnapshot,
  ToolCallSubagentSnapshot,
} from './tool-call/types';

// Re-export snapshot interfaces for group components.
export type { ToolCallSubagentSnapshot, ToolCallReadSnapshot };

const STREAMING_PROGRESS_INTERVAL_MS = 1000;
const PROGRESS_URL_RE = /https?:\/\/\S+/g;
const MAX_LIVE_OUTPUT_CHARS = 50_000;

const DETACH_HINT_DELAY_MS = 10_000;
const DETACH_HINT_TEXT = t('tui.messages.toolCall.detachHint');

const MAX_PROGRESS_LINES = 24;

export class ToolCallComponent extends Container {
  private expanded = false;
  private toolCall: ToolCallBlockData;
  private readonly markdownTheme = createMarkdownTheme();
  private result: ToolResultBlockData | undefined;
  private ui: TUI | undefined;
  private planPath: string | undefined;
  private currentPlan: string | undefined;
  private headerText: Text;
  private callPreviewEndIndex = 0;

  // ── Subagent state (delegated to SubagentStateManager) ──
  private subagent: SubagentStateManager;

  // ── UI state ──
  private progressLines: string[] = [];
  private liveOutput = '';
  private detachHintTimer: ReturnType<typeof setTimeout> | undefined;
  private detachHintVisible = false;
  private streamingProgressTimer: ReturnType<typeof setInterval> | undefined;
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
    this.ui = ui;

    this.subagent = new SubagentStateManager(toolCall, result, workspaceDir);
    this.subagent.applyReplay(toolCall.subagent);
    this.subagent.setOnStateChange(() => {
      this.headerText.setText(this.buildHeader());
      this.rebuildContent();
      this.notifySnapshotChange();
      this.ui?.requestRender();
    });

    this.addChild(new Spacer(1));
    this.headerText = new Text(this.buildHeader(), 0, 0);
    this.addChild(this.headerText);
    this.buildCallPreview();
    this.callPreviewEndIndex = this.children.length;
    this.buildProgressBlock();
    this.buildLiveOutputBlock();
    this.buildContent();
    this.buildSubagentBlock();
    this.syncStreamingProgressTimer();
    this.subagent.syncElapsedTimer(this.isSingleSubagentView(), () => {
      this.headerText.setText(this.buildHeader());
      this.notifySnapshotChange();
      this.ui?.requestRender();
    });
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

  override invalidate(): void {
    this.renderCache = undefined;
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    super.invalidate();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.rebuildBody();
  }

  setResult(result: ToolResultBlockData): void {
    this.result = result;
    this.progressLines = [];
    this.liveOutput = '';
    this.detachHintVisible = false;
    this.stopDetachHintTimer();
    this.subagent.setResult(result);
    this.syncStreamingProgressTimer();
    this.subagent.syncElapsedTimer(this.isSingleSubagentView(), () => {
      this.headerText.setText(this.buildHeader());
      this.notifySnapshotChange();
      this.ui?.requestRender();
    });
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    this.notifySnapshotChange();
  }

  updateToolCall(toolCall: ToolCallBlockData): void {
    this.toolCall = toolCall;
    this.subagent.updateToolCall(toolCall);
    this.syncStreamingProgressTimer();
    this.headerText.setText(this.buildHeader());
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendProgress(text: string): void {
    if (this.result !== undefined) return;
    for (const line of text.split('\n')) {
      this.progressLines.push(line);
    }
    while (this.progressLines.length > MAX_PROGRESS_LINES) {
      this.progressLines.shift();
    }
    this.rebuildBody();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  appendLiveOutput(text: string): void {
    if (this.result !== undefined || text.length === 0) return;
    this.liveOutput += text;
    if (this.liveOutput.length > MAX_LIVE_OUTPUT_CHARS) {
      this.liveOutput = `${t('tui.messages.toolCall.truncatedMarker')}\n${this.liveOutput.slice(
        this.liveOutput.length - MAX_LIVE_OUTPUT_CHARS,
      )}`;
    }
    this.rebuildContent();
    this.notifySnapshotChange();
    this.ui?.requestRender();
  }

  dispose(): void {
    this.stopStreamingProgressTimer();
    this.subagent.dispose();
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

  // ── Subagent API (called by KimiTUI event routing) ──

  setSubagentMeta(agentId: string, agentName?: string): void {
    // Delegate to manager; its onStateChange callback handles rebuild
    this.subagent.onSpawned({ agentId, agentName, runInBackground: false });
  }

  setSnapshotListener(cb: (() => void) | undefined): void {
    this.onSnapshotChange = cb;
    if (cb !== undefined) cb();
  }

  getSubagentSnapshot(): ToolCallSubagentSnapshot {
    return this.subagent.getSnapshot();
  }

  getReadSnapshot(): ToolCallReadSnapshot {
    return this.subagent.getReadSnapshot();
  }

  get toolCallView(): Readonly<ToolCallBlockData> {
    return this.toolCall;
  }

  private notifySnapshotChange(): void {
    this.onSnapshotChange?.();
  }

  // ── Streaming Edit preview timer ──

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

  // ── Detach hint timer ──

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
    }, DETACH_HINT_DELAY_MS);
  }

  private stopDetachHintTimer(): void {
    if (this.detachHintTimer === undefined) return;
    clearTimeout(this.detachHintTimer);
    this.detachHintTimer = undefined;
  }

  private buildDetachHintBlock(): void {
    if (!this.detachHintVisible) return;
    if (this.result !== undefined) return;
    this.addChild(new Text(currentTheme.dim(DETACH_HINT_TEXT), 2, 0));
  }

  // ── Subagent event handlers (delegate to manager) ──

  onSubagentSpawned(meta: SubagentSpawnedMeta): void {
    this.subagent.onSpawned(meta);
    this.subagent.syncElapsedTimer(this.isSingleSubagentView(), () => {
      this.headerText.setText(this.buildHeader());
      this.notifySnapshotChange();
      this.ui?.requestRender();
    });
  }

  onSubagentStarted(meta: SubagentStartedMeta): void {
    this.subagent.onStarted(meta);
    this.subagent.syncElapsedTimer(this.isSingleSubagentView(), () => {
      this.headerText.setText(this.buildHeader());
      this.notifySnapshotChange();
      this.ui?.requestRender();
    });
  }

  onSubagentCompleted(payload: SubagentCompletedPayload): void {
    this.subagent.onCompleted(payload);
    this.subagent.syncElapsedTimer(this.isSingleSubagentView(), () => {
      this.headerText.setText(this.buildHeader());
      this.notifySnapshotChange();
      this.ui?.requestRender();
    });
  }

  updateSubagentMetrics(payload: SubagentMetricsPayload): void {
    this.subagent.updateMetrics(payload);
    this.invalidate();
    this.ui?.requestRender();
  }

  onSubagentFailed(payload: SubagentFailedPayload): void {
    this.subagent.onFailed(payload);
    this.subagent.syncElapsedTimer(this.isSingleSubagentView(), () => {
      this.headerText.setText(this.buildHeader());
      this.notifySnapshotChange();
      this.ui?.requestRender();
    });
  }

  setBackgroundTaskTerminalStatus(
    status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost',
    options: { errorText?: string | undefined } = {},
  ): void {
    this.subagent.setBackgroundTaskTerminalStatus(status, options);
  }

  markBackgrounded(): void {
    this.subagent.markBackgrounded();
    this.ui?.requestRender();
  }

  getSubagentAgentId(): string | undefined {
    return this.subagent.getAgentId();
  }

  getAgentToolDescription(): string | undefined {
    return this.subagent.getAgentToolDescription();
  }

  appendSubagentText(text: string, kind: 'thinking' | 'text' = 'text'): void {
    this.subagent.appendText(text, kind);
  }

  appendSubToolCall(call: { id: string; name: string; args: Record<string, unknown> }): void {
    this.subagent.appendSubToolCall(call);
  }

  appendSubToolCallDelta(delta: {
    id: string;
    name?: string | undefined;
    argumentsPart: string | null;
  }): void {
    this.subagent.appendSubToolCallDelta(delta);
  }

  appendSubToolLiveOutput(id: string, text: string): void {
    this.subagent.appendSubToolLiveOutput(id, text);
  }

  finishSubToolCall(result: {
    tool_call_id: string;
    output: string;
    is_error?: boolean | undefined;
  }): void {
    this.subagent.finishSubToolCall(result);
  }

  // ── Header building ──

  private buildHeader(): string {
    const { toolCall, result } = this;
    const isFinished = result !== undefined;
    const isError = result?.is_error ?? false;
    const isTruncated = toolCall.truncated === true && !isFinished;

    let bullet: string;
    if (isFinished) {
      bullet = isError ? currentTheme.fg('error', '✗ ') : currentTheme.fg('success', STATUS_BULLET);
    } else if (isTruncated) {
      bullet = currentTheme.fg('error', '✗ ');
    } else {
      bullet = currentTheme.fg('text', STATUS_BULLET);
    }

    if (toolCall.name === 'ExitPlanMode') {
      const label = currentTheme.boldFg('primary', t('tui.messages.toolCall.currentPlan'));
      if (!isFinished || result === undefined || result.is_error === true) {
        return label;
      }
      const outcome = interpretExitPlanModeOutcome(result.output);
      if (outcome.kind === 'approved') {
        if (outcome.autoApproved === true) {
          return `${label}${currentTheme.fg('success', t('tui.messages.toolCall.planAutoApproved'))}`;
        }
        const chipText =
          outcome.chosen !== undefined && outcome.chosen.length > 0
            ? t('tui.messages.toolCall.approvedWithOption', { option: outcome.chosen })
            : t('tui.messages.toolCall.approved');
        return `${label}${currentTheme.fg('success', ` · ${chipText}`)}`;
      }
      return label;
    }

    if (toolCall.name === 'AskUserQuestion') {
      const isBackgroundAsk = toolCall.args['background'] === true;
      const label = isFinished
        ? isError
          ? t('tui.messages.toolCall.couldNotCollectInput')
          : isBackgroundAsk
            ? t('tui.messages.toolCall.startedBackgroundQuestion')
          : t('tui.messages.toolCall.collectedAnswers')
        : isBackgroundAsk
          ? t('tui.messages.toolCall.startingBackgroundQuestion')
          : t('tui.messages.toolCall.waitingForInput');
      const tone = isError ? 'error' : 'primary';
      return `${bullet}${currentTheme.boldFg(tone, label)}`;
    }

    if (toolCall.name === 'Bash') {
      if (isTruncated) {
        return `${bullet}${currentTheme.fg('error', t('tui.messages.toolCall.verbTruncated'))} ${currentTheme.boldFg('primary', 'Bash')}`;
      }
      const label = isFinished
        ? t('tui.messages.toolCall.ranCommand')
        : t('tui.messages.toolCall.runningCommand');
      const tone = isError ? 'error' : 'primary';
      const chipStr = isFinished && result !== undefined ? this.buildHeaderChip(result) : '';
      return `${bullet}${currentTheme.boldFg(tone, label)}${chipStr}`;
    }

    const goalHeader = buildGoalToolHeader({
      toolCall,
      result,
      bullet,
      chip: isFinished && result !== undefined ? this.buildHeaderChip(result) : '',
    });
    if (goalHeader !== undefined) return goalHeader;

    if (this.isSingleSubagentView()) {
      return this.buildSingleSubagentHeader();
    }

    const verb = isFinished
      ? t('tui.messages.toolCall.used')
      : isTruncated
        ? t('tui.messages.toolCall.verbTruncated')
        : t('tui.messages.toolCall.using');
    const keyArg = extractKeyArgument(toolCall.name, toolCall.args, this.workspaceDir);
    const decoded = decodeMcpToolName(toolCall.name);
    const verbStyled = isTruncated
      ? currentTheme.fg('error', verb)
      : verb;
    const toolLabel =
      decoded !== null
        ? `${currentTheme.boldFg('primary', decoded.toolName)}${currentTheme.dim(` · MCP/${decoded.serverName}`)}`
        : currentTheme.boldFg('primary', toolCall.name);
    const argStr = keyArg ? currentTheme.dim(` (${keyArg})`) : '';
    let chipStr = '';
    if (isFinished && result) chipStr = this.buildHeaderChip(result);
    return `${bullet}${verbStyled} ${toolLabel}${argStr}${chipStr}`;
  }

  private buildHeaderChip(result: ToolResultBlockData): string {
    const provider = pickChip(this.toolCall.name);
    if (provider === undefined) return '';
    const text = provider(this.toolCall, result);
    if (text.length === 0) return '';
    if (result.is_error) return currentTheme.fg('error', ` · ${text}`);
    return currentTheme.dim(` · ${text}`);
  }

  // ── Body building ──

  private rebuildContent(): void {
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
    while (this.children.length > 2) {
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
    this.addChild(
      new ShellExecutionComponent({
        result: {
          tool_call_id: this.toolCall.id,
          output: this.liveOutput,
          is_error: false,
        },
        expanded: this.expanded,
        resultPreviewLines: RESULT_PREVIEW_LINES,
        tailOutput: true,
        expandHint: false,
      }),
    );
  }

  // ── Subagent block rendering ──

  private buildSubagentBlock(): void {
    if (!this.subagent.hasState()) return;

    if (this.isSingleSubagentView()) {
      this.buildSingleSubagentBlock();
      return;
    }

    const phaseChip = this.formatPhaseChip();
    const headerLabel =
      this.subagent.agentNameValue !== undefined
        ? t('tui.messages.toolCall.subagentWithName', {
            name: this.subagent.agentNameValue,
            id: this.formatAgentId(),
          })
        : t('tui.messages.toolCall.subagentNoName', { id: this.formatAgentId() });
    this.addChild(new Text(`  ${currentTheme.dim(`↳ ${headerLabel}`)}${phaseChip}`, 0, 0));

    if (this.subagent.hiddenSubCallCountValue > 0) {
      this.addChild(
        new Text(
          currentTheme.italic(
            currentTheme.dim(
              `    ${t(
                this.subagent.hiddenSubCallCountValue === 1
                  ? 'tui.messages.toolCall.moreToolCalls_one'
                  : 'tui.messages.toolCall.moreToolCalls_other',
                { count: this.subagent.hiddenSubCallCountValue },
              )} ...`,
            ),
          ),
          0, 0,
        ),
      );
    }

    for (const sub of this.subagent.finishedSubCallsList) {
      const mark = sub.isError
        ? currentTheme.fg('error', '✗')
        : currentTheme.fg('success', '•');
      const keyArg = extractKeyArgument(sub.name, sub.args, this.workspaceDir);
      const nameCol = currentTheme.fg('primary', sub.name);
      const argCol = keyArg ? currentTheme.dim(` (${keyArg})`) : '';
      this.addChild(new Text(`    ${mark} ${t('tui.messages.toolCall.used')} ${nameCol}${argCol}`, 0, 0));
    }

    for (const [, call] of this.subagent.ongoingSubCallsMap) {
      const keyArg = extractKeyArgument(call.name, call.args, this.workspaceDir);
      const nameCol = currentTheme.fg('primary', call.name);
      const argCol = keyArg ? currentTheme.dim(` (${keyArg})`) : '';
      this.addChild(
        new Text(`    ${currentTheme.dim('…')} ${t('tui.messages.toolCall.using')} ${nameCol}${argCol}`, 0, 0),
      );
    }

    if (this.subagent.textValue.length > 0) {
      const tailLines = this.subagent.textValue.split('\n').slice(-3);
      for (const line of tailLines) {
        this.addChild(new Text(`    ${currentTheme.dim(line)}`, 0, 0));
      }
    }

    if (this.subagent.phaseValue === 'done' && this.subagent.resultSummaryValue !== undefined) {
      const summaryLines = this.subagent.resultSummaryValue.split('\n').slice(0, 2);
      for (const line of summaryLines) {
        this.addChild(new Text(`    ${currentTheme.dim('└')} ${line}`, 0, 0));
      }
    }

    if (this.subagent.phaseValue === 'failed' && this.subagent.errorValue !== undefined) {
      const errLines = this.subagent.errorValue.split('\n');
      for (const line of errLines) {
        this.addChild(new Text(`    ${currentTheme.fg('error', '└')} ${line}`, 0, 0));
      }
    }
  }

  private formatPhaseChip(): string {
    const phase = this.subagent.phaseValue;
    if (phase === undefined) return '';
    const parts: string[] = [];
    switch (phase) {
      case 'queued':
        parts.push(`○ ${t('tui.messages.toolCall.phaseQueued')}`);
        break;
      case 'spawning':
        parts.push(`↻ ${t('tui.messages.toolCall.phaseStarting')}`);
        break;
      case 'running':
        parts.push(`↻ ${t('tui.messages.toolCall.phaseRunning')}`);
        break;
      case 'done': {
        parts.push(currentTheme.fg('success', `✓ ${t('tui.messages.toolCall.phaseDone')}`));
        const toolCount = this.subagent.finishedSubCallsList.length + this.subagent.hiddenSubCallCountValue;
        if (toolCount > 0) {
          parts.push(
            t(
              toolCount === 1
                ? 'tui.messages.toolCall.toolCount_one'
                : 'tui.messages.toolCall.toolCount_other',
              { count: toolCount },
            ),
          );
        }
        const tokens =
          this.subagent.formatContextTokens() ??
          this.subagent.formatTokensDisplay();
        if (tokens !== undefined) parts.push(tokens);
        break;
      }
      case 'failed':
        parts.push(currentTheme.fg('error', `✗ ${t('tui.messages.toolCall.phaseFailed')}`));
        break;
      case 'backgrounded':
        parts.push(`◐ ${t('tui.messages.toolCall.phaseBackgrounded')}`);
        break;
    }
    return parts.length > 0 ? currentTheme.dim(` · ${parts.join(' · ')}`) : '';
  }

  private formatAgentId(): string {
    const id = this.subagent.agentIdValue ?? '';
    return id.length > 10 ? id.slice(0, 10) + '…' : id;
  }

  private isSingleSubagentView(): boolean {
    return this.toolCall.name === 'Agent' && this.subagent.hasState();
  }

  // ── Single subagent header ──

  private buildSingleSubagentHeader(): string {
    const phase = this.subagent.getDerivedPhase();
    const isDone = phase === 'done';
    const marker = this.buildSingleSubagentMarker(phase);
    const labelText = formatSubagentLabel(this.subagent.agentNameValue);
    const label = currentTheme.boldFg('primary', labelText);
    const status = this.formatSingleSubagentStatus(phase);
    const rawDescription = str(this.toolCall.args['description']);
    const description =
      rawDescription.length > this.subagent.maxSubagentDescriptionLength
        ? `${rawDescription.slice(0, this.subagent.maxSubagentDescriptionLength - 1)}…`
        : rawDescription;
    const descriptionPlain = description.length > 0 ? ` (${description})` : '';
    const descriptionText = descriptionPlain.length > 0 ? currentTheme.dim(descriptionPlain) : '';
    const statsText = this.formatSingleSubagentStatsText();
    if (isDone) {
      return `${marker}${currentTheme.boldFg('success', labelText)} ${currentTheme.fg('success', t('tui.messages.toolCall.singleSubagentCompleted', { description: descriptionPlain, stats: statsText }))}`;
    }
    const stats = currentTheme.dim(statsText);
    return `${marker}${label} ${status}${descriptionText}${stats}`;
  }

  private formatSingleSubagentStatus(phase: SubagentPhase | undefined): string {
    switch (phase) {
      case 'done':
        return currentTheme.fg('success', t('tui.messages.toolCall.singleSubagent.completed'));
      case 'failed':
        return currentTheme.fg('error', t('tui.messages.toolCall.singleSubagent.failed'));
      case 'running':
        return currentTheme.fg('primary', t('tui.messages.toolCall.singleSubagent.running'));
      case 'backgrounded':
        return t('tui.messages.toolCall.singleSubagent.backgrounded');
      case 'queued':
        return currentTheme.fg('primary', t('tui.messages.toolCall.singleSubagent.queued'));
      case 'spawning':
      case undefined:
        return currentTheme.fg('primary', t('tui.messages.toolCall.singleSubagent.starting'));
    }
  }

  private formatSingleSubagentStatsText(): string {
    const toolCount = this.subagent.subToolActivitiesMap.size;
    const parts = [
      t('tui.messages.toolCall.singleSubagent.toolCount', { n: toolCount }),
    ];
    const elapsed = this.subagent.getElapsedSeconds();
    if (elapsed !== undefined) parts.push(formatElapsed(elapsed));
    const tokens =
      this.subagent.contextTokensValue && this.subagent.contextTokensValue > 0
        ? this.subagent.contextTokensValue
        : this.subagent.usageValue === undefined
          ? 0
          : usageTotal(this.subagent.usageValue);
    if (tokens > 0) parts.push(formatTokens(tokens));
    return ` · ${parts.join(' · ')}`;
  }

  private buildSingleSubagentMarker(phase: SubagentPhase | undefined): string {
    if (phase === 'failed') return currentTheme.fg('error', '✗ ');
    if (phase === 'done') return currentTheme.fg('success', STATUS_BULLET);
    if (phase === 'backgrounded') return currentTheme.dim('◐ ');
    const frame = BRAILLE_SPINNER_FRAMES[this.subagent.spinnerFrameValue] ?? BRAILLE_SPINNER_FRAMES[0];
    return currentTheme.fg('primary', `${frame} `);
  }

  // ── Single subagent block ──

  private buildSingleSubagentBlock(): void {
    const phase = this.subagent.getDerivedPhase();

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
    for (const activity of this.subagent.subToolActivitiesMap.values()) {
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
      (current.name === 'Bash' || isGenericToolResult(current.name))
    ) {
      return { text: current.output, tone: 'text' };
    }
    if (this.subagent.lastStreamKindValue === 'thinking' && this.subagent.thinkingTextValue.trim().length > 0) {
      return { text: this.subagent.thinkingTextValue.trimEnd(), tone: 'thinking' };
    }
    if (this.subagent.textValue.trim().length > 0) {
      return { text: this.subagent.textValue, tone: 'text' };
    }
    if (this.subagent.thinkingTextValue.trim().length > 0) {
      return { text: this.subagent.thinkingTextValue.trimEnd(), tone: 'thinking' };
    }
    return undefined;
  }

  private buildSingleSubagentSummaryLine(): string {
    const toolCount = this.subagent.subToolActivitiesMap.size;
    const countLabel = t(
      toolCount === 1
        ? 'tui.messages.toolCall.toolCount_one'
        : 'tui.messages.toolCall.toolCount_other',
      { count: toolCount },
    );
    const current = this.getCurrentSubToolActivity();
    if (current === undefined) {
      return currentTheme.dim(`  · ${countLabel}`);
    }
    const verb =
      current.phase === 'ongoing'
        ? t('tui.messages.toolCall.using')
        : t('tui.messages.toolCall.used');
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
    const styled =
      content === undefined
        ? currentTheme.dim('…')
        : content.tone === 'thinking'
          ? currentTheme.dim(content.text)
          : currentTheme.fg('textDim', content.text);
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
    const source = kind === 'error' ? this.subagent.errorValue : this.subagent.textValue;
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

  // ── Call preview ──

  private buildCallPreview(): void {
    const components = buildCallPreview({
      toolCall: this.toolCall,
      result: this.result,
      expanded: this.expanded,
      markdownTheme: this.markdownTheme,
      currentPlan: this.currentPlan,
      planPath: this.planPath,
    });
    for (const component of components) {
      this.addChild(component);
    }
  }

  // ── Content building ──

  private buildContent(): void {
    const { result } = this;
    if (result === undefined) return;
    const components = buildResultContent({
      toolCall: this.toolCall,
      result,
      expanded: this.expanded,
      isSingleSubagentView: this.isSingleSubagentView(),
    });
    for (const component of components) {
      this.addChild(component);
    }
  }
}
