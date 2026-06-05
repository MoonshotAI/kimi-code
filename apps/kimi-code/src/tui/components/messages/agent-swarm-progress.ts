import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import {
  AgentSwarmProgressEstimator,
  type AgentSwarmProgressEstimatorPhase,
} from '#/tui/components/messages/agent-swarm-progress-estimator';
import { FAILURE_MARK, SUCCESS_MARK } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

const TEXT_CELL_PREFERRED_WIDTH = 30;
const CELL_GAP = '  ';
const FRAME_INTERVAL_MS = 80;
const TEXT_BRAILLE_BAR_MIN_WIDTH = 6;
const BRAILLE_BAR_MAX_WIDTH = 8;
const BRAILLE_EMPTY = '⣀';
const BRAILLE_RIGHT_COLUMN_FULL = '⢸';
const BRAILLE_LEVELS = ['⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;
const PHASE_LABEL_WIDTH = 'Completed'.length;
const MIN_LABEL_WIDTH = PHASE_LABEL_WIDTH;
const MAX_LATEST_MODEL_CHARS = 2_000;
const COMPLETE_FILL_MS = 360;
const FAILED_PLACEHOLDER_RED_FACTOR = 0.75;
const FAILED_PLACEHOLDER_NON_RED_FACTOR = 0.25;
const STATUS_BAR_CHAR = '━';
const CANCELLED_MARK = '⊘ ';
const TOTAL_STATUS_BAR_GAP = 2;
const PROMPTING_TEXT_TRAILING_GAP = 1;
const ACTIVITY_SPINNER_PLACEHOLDER = '  ';
const AGENT_SWARM_LEFT_INDENT = ' ';
const AGENT_SWARM_RIGHT_GAP = 1;
const AGENT_SWARM_NON_GRID_LINES = 6;
const ORCHESTRATING_LABEL = 'Orchestrating...';
const PROMPTING_LABEL = 'Prompting...';
const WORKING_LABEL = 'Working...';
const COMPLETED_LABEL = 'Completed.';
const FAILED_LABEL = 'Failed.';
const ABORTED_LABEL = 'Aborted.';
const QUEUED_LABEL = 'Queued...';
const SUSPENDED_LABEL = 'Suspended...';
const RESUMED_ITEM_LABEL = '(resumed)';

const STATUS_BAR_ORDER = [
  'completed',
  'working',
  'suspended',
  'queued',
  'cancelled',
  'failed',
] as const;

type AgentSwarmPhase = AgentSwarmProgressEstimatorPhase;
type StatusBarPhase = typeof STATUS_BAR_ORDER[number];
type TotalStatus = 'working' | 'completed' | 'suspended' | 'failed' | 'aborted';

interface AgentSwarmMember {
  readonly id: string;
  agentId?: string;
  phase: AgentSwarmPhase;
  ticks: number;
  itemText: string;
  latestModelText: string;
  completedText?: string;
  failureText?: string;
  suspendedReason?: string;
  completedAtMs?: number;
  failedAtMs?: number;
}

interface AgentSwarmSnapshot {
  readonly phase: AgentSwarmPhase;
  readonly ticks: number;
  readonly latestModelText: string;
  readonly phaseElapsedMs: number;
}

interface AgentSwarmResultStatus {
  readonly index: number;
  readonly status: 'completed' | 'failed';
  readonly completedText?: string;
  readonly failureText?: string;
}

export interface AgentSwarmResultSummary {
  readonly completed: number;
  readonly failed: number;
  readonly aborted: number;
  readonly parsed: boolean;
}

interface AgentSwarmSummary {
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface AgentSwarmGridLayoutInput {
  readonly width: number;
  readonly height: number;
  readonly count: number;
}

export interface AgentSwarmGridLayout {
  readonly renderText: boolean;
  readonly barCells: number;
  readonly columns: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly columnGap: number;
  readonly leftPadding: number;
}

export interface AgentSwarmProgressOptions {
  readonly description: string;
  readonly colors: ColorPalette;
  readonly requestRender?: () => void;
  readonly availableGridHeight?: () => number | undefined;
}

const PHASE_LABELS: Record<AgentSwarmPhase, string> = {
  pending: QUEUED_LABEL,
  queued: QUEUED_LABEL,
  suspended: SUSPENDED_LABEL,
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: ABORTED_LABEL,
};

export class AgentSwarmProgressComponent implements Component {
  private members: AgentSwarmMember[];
  private readonly progressEstimator = new AgentSwarmProgressEstimator();
  private description: string;
  private readonly colors: ColorPalette;
  private readonly requestRender: (() => void) | undefined;
  private readonly availableGridHeight: (() => number | undefined) | undefined;
  private inputComplete = false;
  private failed = false;
  private aborted = false;
  private itemsStarted = false;
  private toolCallActive = true;
  private promptTemplateText = '';
  private activitySpinnerText: (() => string) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AgentSwarmProgressOptions) {
    this.description = options.description;
    this.colors = options.colors;
    this.requestRender = options.requestRender;
    this.availableGridHeight = options.availableGridHeight;
    this.members = [];
  }

  dispose(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {}

  setActivitySpinnerText(provider: (() => string) | undefined): void {
    if (!this.toolCallActive) return;
    this.activitySpinnerText = provider;
  }

  markToolCallEnded(): void {
    this.toolCallActive = false;
    this.activitySpinnerText = undefined;
  }

  isToolCallActive(): boolean {
    return this.toolCallActive;
  }

  isRequestStreaming(): boolean {
    return !this.inputComplete;
  }

  updateArgs(
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined } = {},
  ): void {
    const description = agentSwarmDescriptionFromArgs(args);
    if (description.length > 0 || this.description.length === 0) {
      this.description = description;
    }
    const fullResumeItems = agentSwarmResumeItemsFromArgs(args);
    const partialResumeItems =
      options.streamingArguments === undefined
        ? []
        : agentSwarmPartialResumeItemsFromArguments(options.streamingArguments);
    const fullItems = agentSwarmItemsFromArgs(args);
    const partialItems =
      options.streamingArguments === undefined
        ? []
        : agentSwarmPartialItemsFromArguments(options.streamingArguments);
    const fullRows = [...fullResumeItems, ...fullItems];
    const partialRows = [...partialResumeItems, ...partialItems];
    if (
      fullRows.length > 0 ||
      partialRows.length > 0 ||
      (
        options.streamingArguments !== undefined &&
        agentSwarmWorkItemsStartedFromArguments(options.streamingArguments)
      )
    ) {
      this.itemsStarted = true;
    }
    const fullPromptTemplate = agentSwarmPromptTemplateFromArgs(args);
    const partialPromptTemplate =
      options.streamingArguments === undefined
        ? ''
        : agentSwarmPartialPromptTemplateFromArguments(options.streamingArguments);
    const promptTemplate =
      fullPromptTemplate.length > 0 ? fullPromptTemplate : partialPromptTemplate;
    if (promptTemplate.length > 0 || this.promptTemplateText.length === 0) {
      this.promptTemplateText = promptTemplate;
    }

    const itemCount = Math.max(fullRows.length, partialRows.length);
    if (itemCount > 0) this.ensureMemberCount(itemCount);
    this.updateItemTexts(fullRows, partialRows);
  }

  markInputComplete(): void {
    if (!this.inputComplete) {
      this.inputComplete = true;
      for (const member of this.members) {
        if (member.phase === 'pending') member.phase = 'queued';
      }
    }
    this.startAnimationIfNeeded();
  }

  registerSubagent(input: {
    readonly agentId: string;
    readonly description?: string | undefined;
  }): void {
    const member = this.findMemberForSubagent(input.agentId, input.description);
    if (member === undefined) return;
    member.agentId = input.agentId;
    if (member.phase === 'pending') member.phase = 'queued';
    this.startAnimationIfNeeded();
  }

  markStarted(agentId: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined) return;
    const nowMs = Date.now();
    this.progressEstimator.markStarted(member.id, nowMs);
    member.ticks = Math.max(member.ticks, 1);
    if (member.phase === 'pending' || member.phase === 'queued' || member.phase === 'suspended') {
      member.phase = 'running';
    }
    delete member.suspendedReason;
    this.startAnimationIfNeeded();
  }

  recordToolCall(input: {
    readonly agentId: string;
    readonly toolCallId: string;
  }): void {
    const member = this.findMemberByAgentId(input.agentId);
    if (member === undefined) return;
    const result = this.progressEstimator.recordToolCall({
      memberKey: member.id,
      toolCallId: input.toolCallId,
      nowMs: Date.now(),
    });
    if (!result.accepted) return;
    member.ticks = result.rawTicks;
    if (member.phase === 'pending' || member.phase === 'queued' || member.phase === 'suspended') {
      member.phase = 'running';
    }
    delete member.suspendedReason;
    this.startAnimationIfNeeded();
  }

  appendModelDelta(input: {
    readonly agentId: string;
    readonly delta: string;
  }): void {
    const member = this.findMemberByAgentId(input.agentId);
    if (member === undefined || input.delta.length === 0) return;
    member.latestModelText = `${member.latestModelText}${input.delta}`.slice(
      -MAX_LATEST_MODEL_CHARS,
    );
    if (member.phase === 'pending' || member.phase === 'queued' || member.phase === 'suspended') {
      this.progressEstimator.markStarted(member.id, Date.now());
      member.ticks = Math.max(member.ticks, 1);
      member.phase = 'running';
    }
    delete member.suspendedReason;
  }

  appendAssistantDelta(input: {
    readonly agentId: string;
    readonly delta: string;
  }): void {
    this.appendModelDelta(input);
  }

  markCompleted(agentId: string, completedText?: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined || member.phase === 'failed' || member.phase === 'cancelled') return;
    const nowMs = Date.now();
    if (member.phase !== 'completed') {
      this.progressEstimator.markCompleted(member.id, nowMs);
      member.completedAtMs = nowMs;
    }
    const normalizedCompletedText = normalizeFinalOutputText(completedText);
    if (normalizedCompletedText !== undefined) member.completedText = normalizedCompletedText;
    delete member.failedAtMs;
    delete member.failureText;
    delete member.suspendedReason;
    member.phase = 'completed';
    this.startAnimationIfNeeded();
  }

  markSuspended(input: {
    readonly agentId: string;
    readonly reason: string;
    readonly description?: string | undefined;
  }): void {
    const member = this.findMemberByAgentId(input.agentId) ??
      this.findMemberForSubagent(input.agentId, input.description);
    if (member === undefined || member.phase === 'completed' || member.phase === 'cancelled') return;
    member.agentId = input.agentId;
    this.progressEstimator.markQueued(member.id, Date.now());
    member.phase = 'queued';
    delete member.suspendedReason;
    delete member.completedAtMs;
    delete member.completedText;
    delete member.failedAtMs;
    delete member.failureText;
    this.startAnimationIfNeeded();
  }

  markFailed(agentId: string, failureText?: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined) return;
    const nowMs = Date.now();
    if (member.phase !== 'failed') {
      this.progressEstimator.markFailed(member.id, nowMs);
      member.failedAtMs = nowMs;
    }
    const normalizedFailureText = normalizeFailureText(failureText);
    if (normalizedFailureText !== undefined) member.failureText = normalizedFailureText;
    member.phase = 'failed';
    delete member.completedAtMs;
    delete member.completedText;
    delete member.suspendedReason;
    this.startAnimationIfNeeded();
  }

  markSwarmFailed(failureText?: string): void {
    this.failed = true;
    this.aborted = false;
    const normalizedFailureText = normalizeFailureText(failureText);
    const nowMs = Date.now();
    for (const member of this.members) {
      if (
        member.phase === 'completed' ||
        member.phase === 'failed' ||
        member.phase === 'cancelled'
      ) {
        continue;
      }
      this.progressEstimator.markFailed(member.id, nowMs);
      member.failedAtMs = nowMs;
      if (normalizedFailureText !== undefined) member.failureText = normalizedFailureText;
      member.phase = 'failed';
      delete member.completedAtMs;
      delete member.completedText;
      delete member.suspendedReason;
    }
    this.startAnimationIfNeeded();
  }

  markCancelled(agentId: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined) return;
    this.progressEstimator.markCancelled(member.id, Date.now());
    member.phase = 'cancelled';
    delete member.completedAtMs;
    delete member.completedText;
    delete member.failedAtMs;
    delete member.failureText;
    delete member.suspendedReason;
  }

  markActiveCancelled(): void {
    this.aborted = true;
    const nowMs = Date.now();
    for (const member of this.members) {
      if (
        member.phase === 'completed' ||
        member.phase === 'failed' ||
        member.phase === 'cancelled'
      ) {
        continue;
      }
      this.progressEstimator.markCancelled(member.id, nowMs);
      member.phase = 'cancelled';
      delete member.completedAtMs;
      delete member.completedText;
      delete member.failedAtMs;
      delete member.failureText;
      delete member.suspendedReason;
    }
    this.startAnimationIfNeeded();
  }

  applyResult(output: string): boolean {
    const statuses = parseAgentSwarmResultStatuses(output);
    if (statuses.length === 0) return false;
    this.aborted = false;
    const nowMs = Date.now();
    for (const entry of statuses) {
      this.ensureMemberCount(entry.index);
      const member = this.members[entry.index - 1];
      if (member === undefined) continue;
      if (entry.status === 'completed' && member.phase !== 'completed') {
        this.progressEstimator.markCompleted(member.id, nowMs);
        member.completedAtMs = nowMs;
      }
      if (entry.status === 'completed') {
        const normalizedCompletedText = normalizeFinalOutputText(entry.completedText);
        if (normalizedCompletedText !== undefined) member.completedText = normalizedCompletedText;
      }
      if (entry.status === 'completed') delete member.failedAtMs;
      if (entry.status === 'completed') delete member.failureText;
      if (entry.status === 'completed') delete member.suspendedReason;
      if (entry.status === 'failed' && member.phase !== 'failed') {
        this.progressEstimator.markFailed(member.id, nowMs);
        member.failedAtMs = nowMs;
      }
      if (entry.status === 'failed') {
        const normalizedFailureText = normalizeFailureText(entry.failureText);
        if (normalizedFailureText !== undefined) member.failureText = normalizedFailureText;
      }
      if (entry.status === 'failed') delete member.completedAtMs;
      if (entry.status === 'failed') delete member.completedText;
      if (entry.status === 'failed') delete member.suspendedReason;
      member.phase = entry.status;
    }
    this.startAnimationIfNeeded();
    return true;
  }

  render(width: number): string[] {
    const outerWidth = Math.max(1, width);
    const innerWidth = Math.max(
      1,
      outerWidth - visibleWidth(AGENT_SWARM_LEFT_INDENT) - AGENT_SWARM_RIGHT_GAP,
    );
    if (this.members.length === 0) {
      const lines = [
        '',
        this.renderHeader(innerWidth, undefined),
        '',
        this.renderStatusLine(innerWidth),
        '',
      ];
      return this.indentLines(lines, outerWidth);
    }

    const nowMs = Date.now();
    const snapshots = this.members.map((member): AgentSwarmSnapshot => ({
      phase: member.phase,
      ticks: member.ticks,
      latestModelText: member.latestModelText,
      phaseElapsedMs: terminalPhaseElapsedMs(member, nowMs),
    }));
    const summary = summarizeSnapshots(snapshots);
    const lines = [
      '',
      this.renderHeader(innerWidth, summary),
      '',
      ...this.renderGrid(
        innerWidth,
        this.availableGridHeight?.(),
        snapshots,
        nowMs,
      ),
      '',
      this.renderStatusLine(innerWidth),
      '',
    ];
    this.startAnimationIfNeeded();
    return this.indentLines(lines, outerWidth);
  }

  private indentLines(lines: readonly string[], width: number): string[] {
    const contentWidth = Math.max(
      0,
      width - visibleWidth(AGENT_SWARM_LEFT_INDENT) - AGENT_SWARM_RIGHT_GAP,
    );
    return lines.map((line) =>
      truncateToWidth(
        AGENT_SWARM_LEFT_INDENT + truncateToWidth(line, contentWidth),
        width,
      )
    );
  }

  private renderHeader(width: number, _summary: AgentSwarmSummary | undefined): string {
    if (width <= 3) return chalk.hex(this.colors.primary)('─'.repeat(width));

    const title = chalk.hex(this.colors.primary).bold('Agent swarm');
    const description =
      this.description.length > 0
        ? chalk.hex(this.colors.primary)(' ─ ') + chalk.hex(this.colors.text)(this.description)
        : '';
    const prefixText = '─ ';
    const labelWidth = Math.max(1, width - visibleWidth(prefixText) - 1);
    const label = truncateToWidth(title + description, labelWidth);
    const suffixWidth = Math.max(0, width - visibleWidth(prefixText) - visibleWidth(label));
    const suffix = suffixWidth === 0 ? '' : ` ${'─'.repeat(Math.max(0, suffixWidth - 1))}`;
    return chalk.hex(this.colors.primary)(prefixText) + label + chalk.hex(this.colors.primary)(suffix);
  }

  private renderStatusLine(width: number): string {
    const status = totalStatus(this.members, {
      failed: this.failed,
      aborted: this.aborted,
    });
    const prefix = this.renderActivityPrefix(status);
    if (prefix.length > 0) {
      const contentWidth = Math.max(0, width - visibleWidth(prefix));
      if (contentWidth <= 0) return truncateToWidth(prefix, width);
      return truncateToWidth(`${prefix}${this.renderStatusLineContent(contentWidth, status)}`, width);
    }
    return this.renderStatusLineContent(width, status);
  }

  private renderActivityPrefix(status: TotalStatus): string {
    if (this.toolCallActive) return this.activitySpinnerText?.() ?? '';
    return activityPrefixForTotalStatus(status, this.colors);
  }

  private renderStatusLineContent(width: number, status: TotalStatus): string {
    if (status !== 'working') return this.renderProgressStatusLine(width, status);

    if (!this.inputComplete) {
      return this.renderOrchestratingStatusLine(width);
    }

    return this.renderProgressStatusLine(width, status);
  }

  private renderProgressStatusLine(width: number, status: TotalStatus): string {
    const label = renderTotalStatusLabel(
      totalStatusLabel(status),
      totalStatusLabelColor(status, this.members, this.colors),
    );
    if (this.members.length === 0) return truncateToWidth(label, width);
    const barWidth = Math.max(0, width - visibleWidth(label) - TOTAL_STATUS_BAR_GAP);
    if (barWidth <= 0) return truncateToWidth(label, width);
    return truncateToWidth(
      `${label}${' '.repeat(TOTAL_STATUS_BAR_GAP)}${renderStatusPipBar(this.members, barWidth, this.colors)}`,
      width,
    );
  }

  private renderOrchestratingStatusLine(width: number): string {
    if (this.itemsStarted) {
      return truncateToWidth(
        renderInlineStatusLabel(ORCHESTRATING_LABEL, this.colors.primary),
        width,
      );
    }

    const promptTemplate = collapseWhitespace(this.promptTemplateText);
    const label = renderInlineStatusLabel(
      promptTemplate.length > 0 ? PROMPTING_LABEL : ORCHESTRATING_LABEL,
      this.colors.primary,
    );
    if (promptTemplate.length === 0) return truncateToWidth(label, width);

    const availablePromptWidth = Math.max(
      0,
      width - visibleWidth(label) - PROMPTING_TEXT_TRAILING_GAP,
    );
    const separator = visibleWidth(promptTemplate) <= availablePromptWidth - 1 ? ' ' : '  ';
    const promptWidth = Math.max(0, availablePromptWidth - visibleWidth(separator));
    if (promptWidth <= 0) return truncateToWidth(label, width);
    const prompt = chalk.hex(this.colors.textDim)(truncateStartToWidth(promptTemplate, promptWidth));
    return truncateToWidth(`${label}${separator}${prompt}`, width);
  }

  private renderGrid(
    width: number,
    height: number | undefined,
    snapshots: readonly AgentSwarmSnapshot[],
    nowMs: number,
  ): string[] {
    const layout = calculateAgentSwarmGridLayout({
      width,
      height: height ?? Number.POSITIVE_INFINITY,
      count: this.members.length,
    });
    const columns = Math.max(1, layout.columns);
    const rows = layout.rows;
    const cellGap = ' '.repeat(layout.columnGap);
    const leftPadding = ' '.repeat(layout.leftPadding);
    const lines: string[] = [];

    for (let row = 0; row < rows; row += 1) {
      const cells: string[] = [];
      for (let col = 0; col < columns; col += 1) {
        const index = row * columns + col;
        const member = this.members[index];
        const snapshot = snapshots[index];
        if (member === undefined || snapshot === undefined) continue;
        cells.push(padAnsi(this.renderCell(member, snapshot, layout, nowMs), layout.cellWidth));
      }
      lines.push(leftPadding + cells.join(cellGap));
    }
    return lines;
  }

  private renderCell(
    member: AgentSwarmMember,
    snapshot: AgentSwarmSnapshot,
    layout: AgentSwarmGridLayout,
    nowMs: number,
  ): string {
    const width = layout.cellWidth;
    if (snapshot.phase === 'pending') {
      return renderPendingCell(member, width, this.colors);
    }
    if (!layout.renderText) {
      return this.renderCompactCell(member, snapshot, layout.barCells, nowMs);
    }
    if (snapshot.phase === 'queued' && snapshot.ticks <= 0) {
      return renderQueuedCell(member, width, this.colors);
    }

    const estimate = this.progressEstimator.estimate({
      memberKey: member.id,
      phase: snapshot.phase,
      capacityTicks: layout.barCells * BRAILLE_LEVELS.length,
      nowMs,
    });
    const id = chalk.hex(this.colors.primary)(member.id);
    const bar = brailleBar(
      estimate.displayTicks,
      snapshot.phase,
      layout.barCells,
      this.colors,
      snapshot.phaseElapsedMs,
    );
    const prefix = `${id} ${bar} `;
    const labelWidth = Math.max(1, width - visibleWidth(prefix));
    const label = renderCellLabel(member, snapshot, labelWidth, this.colors);
    return prefix + label;
  }

  private renderCompactCell(
    member: AgentSwarmMember,
    snapshot: AgentSwarmSnapshot,
    barCells: number,
    nowMs: number,
  ): string {
    const estimatePhase = snapshot.phase === 'pending' ? 'queued' : snapshot.phase;
    const estimate = this.progressEstimator.estimate({
      memberKey: member.id,
      phase: estimatePhase,
      capacityTicks: barCells * BRAILLE_LEVELS.length,
      nowMs,
    });
    const id = chalk.hex(this.colors.primary)(member.id);
    const bar = brailleBar(
      estimate.displayTicks,
      estimatePhase,
      barCells,
      this.colors,
      snapshot.phaseElapsedMs,
    );
    return `${id} ${bar}${compactTerminalMark(snapshot.phase, this.colors)}`;
  }

  private findMemberForSubagent(
    agentId: string,
    description: string | undefined,
  ): AgentSwarmMember | undefined {
    const existing = this.findMemberByAgentId(agentId);
    if (existing !== undefined) return existing;

    const index = parseAgentSwarmDescriptionIndex(description);
    if (index !== undefined) {
      this.ensureMemberCount(index);
      const byDescription = this.members[index - 1];
      if (byDescription !== undefined) return byDescription;
    }

    const unassigned = this.members.find((member) => member.agentId === undefined);
    if (unassigned !== undefined) return unassigned;

    this.ensureMemberCount(this.members.length + 1);
    return this.members.at(-1);
  }

  private findMemberByAgentId(agentId: string): AgentSwarmMember | undefined {
    return this.members.find((member) => member.agentId === agentId);
  }

  private ensureMemberCount(count: number): void {
    if (count <= this.members.length) return;
    const previousLength = this.members.length;
    this.members = [
      ...this.members,
      ...createMembers(count, this.inputComplete ? 'queued' : 'pending').slice(this.members.length),
    ];
    const nowMs = Date.now();
    for (let index = previousLength; index < this.members.length; index += 1) {
      const member = this.members[index];
      if (member !== undefined) this.progressEstimator.ensureMember(member.id, nowMs);
    }
  }

  private updateItemTexts(fullItems: readonly string[], partialItems: readonly string[]): void {
    const count = Math.max(fullItems.length, partialItems.length, this.members.length);
    for (let index = 0; index < count; index += 1) {
      const member = this.members[index];
      if (member === undefined) continue;
      const itemText = fullItems[index] ?? partialItems[index];
      if (itemText !== undefined) member.itemText = itemText;
    }
  }

  private startAnimationIfNeeded(): void {
    if (this.requestRender === undefined || this.timer !== undefined) return;
    if (!this.hasAnimatedMembers()) return;
    const requestRender = this.requestRender;
    this.timer = setInterval(() => {
      requestRender();
      if (!this.hasAnimatedMembers()) this.dispose();
    }, FRAME_INTERVAL_MS);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  private hasAnimatedMembers(): boolean {
    const now = Date.now();
    return (
      this.progressEstimator.hasPendingCatchup() ||
      this.members.some((member) =>
        (
          member.phase === 'completed' &&
          member.completedAtMs !== undefined &&
          now - member.completedAtMs < COMPLETE_FILL_MS
        ) ||
        (
          member.phase === 'failed' &&
          member.failedAtMs !== undefined &&
          now - member.failedAtMs < COMPLETE_FILL_MS
        ),
      )
    );
  }
}

function createMembers(count: number, phase: AgentSwarmPhase): AgentSwarmMember[] {
  return Array.from({ length: count }, (_item, index) => ({
    id: String(index + 1).padStart(3, '0'),
    phase,
    ticks: 0,
    itemText: '',
    latestModelText: '',
  }));
}

function terminalPhaseElapsedMs(member: AgentSwarmMember, nowMs: number): number {
  const startedAtMs = member.phase === 'completed'
    ? member.completedAtMs
    : member.phase === 'failed'
      ? member.failedAtMs
      : undefined;
  return startedAtMs === undefined ? 0 : Math.max(0, nowMs - startedAtMs);
}

export function agentSwarmItemsFromArgs(args: Record<string, unknown>): string[] {
  const items = args['items'];
  if (!Array.isArray(items)) return [];
  return items.map(String);
}

function agentSwarmResumeItemsFromArgs(args: Record<string, unknown>): string[] {
  const resumeAgentIds = args['resume_agent_ids'];
  if (
    typeof resumeAgentIds !== 'object' ||
    resumeAgentIds === null ||
    Array.isArray(resumeAgentIds)
  ) {
    return [];
  }
  return Object.keys(resumeAgentIds).map(() => RESUMED_ITEM_LABEL);
}

export function agentSwarmPartialItemsCountFromArguments(argumentsText: string): number {
  return agentSwarmPartialItemsFromArguments(argumentsText).length;
}

function agentSwarmWorkItemsStartedFromArguments(argumentsText: string): boolean {
  return /"items"\s*:/.test(argumentsText) || /"resume_agent_ids"\s*:/.test(argumentsText);
}

export function agentSwarmPartialItemsFromArguments(argumentsText: string): string[] {
  const match = /"items"\s*:\s*\[/.exec(argumentsText);
  if (match === null) return [];
  const items: string[] = [];
  for (let i = match.index + match[0].length; i < argumentsText.length; i += 1) {
    const ch = argumentsText[i];
    if (ch === ']') return items;
    if (ch !== '"') continue;

    const parsed = parsePartialJsonString(argumentsText, i + 1);
    items.push(parsed.value);
    if (parsed.closed) {
      i = parsed.nextIndex;
      continue;
    }
    return items;
  }
  return items;
}

function agentSwarmPartialResumeItemsFromArguments(argumentsText: string): string[] {
  const match = /"resume_agent_ids"\s*:\s*\{/.exec(argumentsText);
  if (match === null) return [];
  return Array.from(
    { length: countPartialJsonObjectEntries(argumentsText, match.index + match[0].length) },
    () => RESUMED_ITEM_LABEL,
  );
}

export function agentSwarmDescriptionFromArgs(args: Record<string, unknown>): string {
  const description = args['description'];
  return typeof description === 'string' ? description : '';
}

function agentSwarmPromptTemplateFromArgs(args: Record<string, unknown>): string {
  const promptTemplate = args['prompt_template'];
  return typeof promptTemplate === 'string' ? promptTemplate : '';
}

function agentSwarmPartialPromptTemplateFromArguments(argumentsText: string): string {
  const match = /"prompt_template"\s*:\s*"/.exec(argumentsText);
  if (match === null) return '';
  return parsePartialJsonString(argumentsText, match.index + match[0].length).value;
}

function parseAgentSwarmDescriptionIndex(description: string | undefined): number | undefined {
  if (description === undefined) return undefined;
  const match = /#(\d+)(?:\s|$|\()/.exec(description);
  if (match === null) return undefined;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : undefined;
}

export function agentSwarmResultSummaryFromOutput(output: string): AgentSwarmResultSummary {
  const statuses = parseAgentSwarmResultStatuses(output);
  const aborted = countAgentSwarmAbortedResultStatuses(output);
  let completed = 0;
  let failed = 0;
  for (const status of statuses) {
    if (status.status === 'completed') completed += 1;
    if (status.status === 'failed') failed += 1;
  }
  return {
    completed,
    failed,
    aborted,
    parsed: completed + failed + aborted > 0,
  };
}

function parseAgentSwarmResultStatuses(output: string): AgentSwarmResultStatus[] {
  const xmlStatuses = parseAgentSwarmXmlResultStatuses(output);
  if (xmlStatuses.length > 0) return xmlStatuses;
  return parseAgentSwarmLegacyResultStatuses(output);
}

function parseAgentSwarmXmlResultStatuses(output: string): AgentSwarmResultStatus[] {
  const result: AgentSwarmResultStatus[] = [];
  const tagPattern = /<subagent\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(output)) !== null) {
    const attrs = match[1] ?? '';
    const closeIndex = output.indexOf('</subagent>', tagPattern.lastIndex);
    if (closeIndex < 0) break;

    const index = Number(xmlAttribute(attrs, 'index'));
    const outcome = xmlAttribute(attrs, 'outcome');
    if (Number.isInteger(index) && index > 0 && (outcome === 'completed' || outcome === 'failed')) {
      const body = output.slice(tagPattern.lastIndex, closeIndex);
      result.push({
        index,
        status: outcome,
        completedText: outcome === 'completed' ? body : undefined,
        failureText: outcome === 'failed' ? body : undefined,
      });
    }

    tagPattern.lastIndex = closeIndex + '</subagent>'.length;
  }
  return result;
}

function countAgentSwarmAbortedResultStatuses(output: string): number {
  const xmlAborted = countAgentSwarmXmlAbortedResultStatuses(output);
  if (xmlAborted > 0) return xmlAborted;
  return countAgentSwarmLegacyAbortedResultStatuses(output);
}

function countAgentSwarmXmlAbortedResultStatuses(output: string): number {
  let count = 0;
  const tagPattern = /<subagent\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(output)) !== null) {
    const attrs = match[1] ?? '';
    const closeIndex = output.indexOf('</subagent>', tagPattern.lastIndex);
    if (closeIndex < 0) break;

    const index = Number(xmlAttribute(attrs, 'index'));
    const outcome = xmlAttribute(attrs, 'outcome');
    if (
      Number.isInteger(index) &&
      index > 0 &&
      (outcome === 'aborted' || outcome === 'cancelled')
    ) {
      count += 1;
    }

    tagPattern.lastIndex = closeIndex + '</subagent>'.length;
  }
  return count;
}

function xmlAttribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match?.[1];
}

function parseAgentSwarmLegacyResultStatuses(output: string): AgentSwarmResultStatus[] {
  const result: AgentSwarmResultStatus[] = [];
  const blocks = output.split(/\n(?=\[agent \d+\]\n)/);
  for (const block of blocks) {
    const indexMatch = /^\[agent (\d+)\]$/m.exec(block);
    const statusMatch = /^status: (completed|failed)$/m.exec(block);
    if (indexMatch === null || statusMatch === null) continue;
    result.push({
      index: Number(indexMatch[1]),
      status: statusMatch[1] as 'completed' | 'failed',
      completedText: parseAgentSwarmCompletedText(block),
      failureText: parseAgentSwarmFailureText(block),
    });
  }
  return result;
}

function countAgentSwarmLegacyAbortedResultStatuses(output: string): number {
  return output.split(/\n(?=\[agent \d+\]\n)/).filter((block) =>
    /^status: (aborted|cancelled)$/m.test(block)
  ).length;
}

function parseAgentSwarmCompletedText(block: string): string | undefined {
  const marker = '\n[summary]\n';
  const markerIndex = block.indexOf(marker);
  if (markerIndex < 0) return undefined;
  return normalizeFinalOutputText(block.slice(markerIndex + marker.length));
}

function parseAgentSwarmFailureText(block: string): string | undefined {
  const match = /^subagent error:\s*([\s\S]*)$/m.exec(block);
  if (match === null) return undefined;
  return normalizeFailureText(match[1]);
}

export function calculateAgentSwarmGridLayout(
  input: AgentSwarmGridLayoutInput,
): AgentSwarmGridLayout {
  const count = Math.max(0, Math.floor(input.count));
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const idWidth = agentSwarmGridIdWidth(count);

  if (count === 0) {
    return {
      renderText: true,
      barCells: 1,
      columns: 0,
      rows: 0,
      cellWidth: 0,
      columnGap: 0,
      leftPadding: 0,
    };
  }

  const textGapWidth = visibleWidth(CELL_GAP);
  const compactGapWidth = textGapWidth;
  const textColumns = columnsForCellWidth(
    width,
    count,
    TEXT_CELL_PREFERRED_WIDTH,
    textGapWidth,
  );
  const textRows = rowsForColumns(count, textColumns);
  const textCellWidth = gridCellWidth(width, textColumns, textGapWidth);
  if (textRows <= height && textCellWidth >= minTextCellWidth(idWidth)) {
    return {
      renderText: true,
      barCells: barCellsForTextCellWidth(textCellWidth, idWidth),
      columns: textColumns,
      rows: textRows,
      cellWidth: textCellWidth,
      columnGap: textGapWidth,
      leftPadding: 0,
    };
  }
  const targetTextColumns = height <= 0 ? count : Math.min(count, Math.ceil(count / height));
  const targetTextCellWidth = gridCellWidth(width, targetTextColumns, textGapWidth);
  const targetTextRows = rowsForColumns(count, targetTextColumns);
  if (
    height > 0 &&
    targetTextRows <= height &&
    targetTextCellWidth >= minTextCellWidth(idWidth)
  ) {
    return {
      renderText: true,
      barCells: barCellsForTextCellWidth(targetTextCellWidth, idWidth),
      columns: targetTextColumns,
      rows: targetTextRows,
      cellWidth: targetTextCellWidth,
      columnGap: textGapWidth,
      leftPadding: 0,
    };
  }

  const compactColumns = compactColumnsForLayout(width, count, height, idWidth, compactGapWidth);
  const compactCellWidthBudget = gridCellWidth(width, compactColumns, compactGapWidth);
  const compactBarCells = compactBarCellsForCellWidth(compactCellWidthBudget, idWidth);
  const compactActualCellWidth = compactCellWidth(idWidth, compactBarCells);
  return {
    renderText: false,
    barCells: compactBarCells,
    columns: compactColumns,
    rows: rowsForColumns(count, compactColumns),
    cellWidth: compactActualCellWidth,
    columnGap: compactGapWidth,
    leftPadding: 0,
  };
}

export function agentSwarmGridHeightForTerminalRows(
  rows: number | undefined,
  followingRows = 0,
): number | undefined {
  if (rows === undefined || !Number.isFinite(rows)) return undefined;
  const rowsAfterSwarm = Number.isFinite(followingRows)
    ? Math.max(0, Math.floor(followingRows))
    : 0;
  return Math.max(0, Math.floor(rows) - rowsAfterSwarm - AGENT_SWARM_NON_GRID_LINES);
}

function agentSwarmGridIdWidth(count: number): number {
  return Math.max(3, String(Math.max(1, count)).length);
}

function columnsForCellWidth(
  width: number,
  count: number,
  cellWidth: number,
  gapWidth: number,
): number {
  if (count <= 1) return count <= 0 ? 0 : 1;
  const columns = Math.floor((width + gapWidth) / (Math.max(1, cellWidth) + gapWidth));
  return Math.max(1, Math.min(count, columns));
}

function rowsForColumns(count: number, columns: number): number {
  if (count <= 0) return 0;
  return Math.ceil(count / Math.max(1, columns));
}

function gridCellWidth(width: number, columns: number, gapWidth: number): number {
  if (columns <= 0) return 0;
  return Math.max(
    1,
    Math.floor((width - gapWidth * Math.max(0, columns - 1)) / columns),
  );
}

function minTextCellWidth(idWidth: number): number {
  return idWidth + TEXT_BRAILLE_BAR_MIN_WIDTH + 4 + MIN_LABEL_WIDTH;
}

function barCellsForTextCellWidth(cellWidth: number, idWidth: number): number {
  const fixedWidth = idWidth + 1 + 2 + 1 + MIN_LABEL_WIDTH;
  const availableForBar = cellWidth - fixedWidth;
  return availableForBar >= TEXT_BRAILLE_BAR_MIN_WIDTH
    ? Math.min(BRAILLE_BAR_MAX_WIDTH, availableForBar)
    : TEXT_BRAILLE_BAR_MIN_WIDTH;
}

function compactColumnsForLayout(
  width: number,
  count: number,
  height: number,
  idWidth: number,
  gapWidth: number,
): number {
  const maxColumns = columnsForCellWidth(width, count, compactCellWidth(idWidth, 1), gapWidth);
  if (height <= 0) return maxColumns;
  const targetColumns = Math.min(count, Math.ceil(count / height));
  return Math.max(1, Math.min(targetColumns, maxColumns));
}

function compactBarCellsForCellWidth(cellWidth: number, idWidth: number): number {
  return Math.max(
    1,
    cellWidth - compactFixedWidth(idWidth) - compactTerminalMarkWidth(),
  );
}

function compactCellWidth(idWidth: number, barCells: number): number {
  return compactFixedWidth(idWidth) + Math.max(1, barCells) + compactTerminalMarkWidth();
}

function compactFixedWidth(idWidth: number): number {
  return idWidth + 1 + 2;
}

function compactTerminalMarkWidth(): number {
  return 1;
}

function summarizeSnapshots(snapshots: readonly AgentSwarmSnapshot[]): AgentSwarmSummary {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const snapshot of snapshots) {
    if (snapshot.phase === 'completed') completed += 1;
    if (snapshot.phase === 'failed') failed += 1;
    if (snapshot.phase === 'cancelled') cancelled += 1;
  }
  return {
    active: snapshots.length - completed - failed - cancelled,
    completed,
    failed,
    cancelled,
  };
}

function brailleBar(
  ticks: number,
  phase: AgentSwarmPhase,
  width: number,
  colors: ColorPalette,
  phaseElapsedMs: number,
): string {
  const innerWidth = Math.max(1, width);
  switch (phase) {
    case 'pending':
      return '';
    case 'queued':
      return bracketBar(accumulatedBrailleBar(ticks, innerWidth, colors.textDim, colors), colors);
    case 'suspended':
      return bracketBar(accumulatedBrailleBar(ticks, innerWidth, colors.warning, colors), colors);
    case 'running':
      return bracketBar(accumulatedBrailleBar(ticks, innerWidth, colors.success, colors), colors);
    case 'completed':
      return bracketBar(
        accumulatedBrailleBar(
          completedDisplayTicks(ticks, innerWidth, phaseElapsedMs),
          innerWidth,
          colors.success,
          colors,
        ),
        colors,
      );
    case 'failed':
      return bracketBar(failedBrailleBar(ticks, innerWidth, phaseElapsedMs, colors), colors);
    case 'cancelled':
      return bracketBar(accumulatedBrailleBar(ticks, innerWidth, colors.warning, colors), colors);
  }
}

function bracketBar(content: string, colors: ColorPalette): string {
  const bracket = chalk.hex(colors.textMuted);
  return bracket('[') + content + bracket(']');
}

function phaseColor(phase: AgentSwarmPhase, colors: ColorPalette): string {
  switch (phase) {
    case 'pending':
    case 'queued':
      return colors.textDim;
    case 'suspended':
      return colors.warning;
    case 'running':
      return colors.textDim;
    case 'completed':
      return colors.success;
    case 'failed':
      return colors.error;
    case 'cancelled':
      return colors.warning;
  }
}

interface StatusBarCount {
  readonly phase: StatusBarPhase;
  readonly count: number;
}

function renderStatusPipBar(
  members: readonly AgentSwarmMember[],
  width: number,
  colors: ColorPalette,
): string {
  const safeWidth = Math.max(1, width);
  const counts = statusBarCounts(members);
  if (counts.length === 0) {
    return chalk.hex(colors.textMuted)(STATUS_BAR_CHAR.repeat(safeWidth));
  }

  const segmentWidths = allocateSegmentWidths(counts.map((entry) => entry.count), safeWidth);
  return counts.map((entry, index) => {
    const segmentWidth = segmentWidths[index] ?? 0;
    if (segmentWidth <= 0) return '';
    return chalk.hex(statusBarColor(entry.phase, colors))(STATUS_BAR_CHAR.repeat(segmentWidth));
  }).join('');
}

function renderTotalStatusLabel(label: string, color: string): string {
  return ` ${chalk.hex(color)(label)}`;
}

function renderInlineStatusLabel(label: string, color: string): string {
  return ` ${chalk.hex(color)(label)}`;
}

function activityPrefixForTotalStatus(status: TotalStatus, colors: ColorPalette): string {
  const color = totalStatusColor(status, colors);
  switch (status) {
    case 'completed':
      return ` ${chalk.hex(color)(SUCCESS_MARK.trimEnd())}`;
    case 'failed':
      return ` ${chalk.hex(color)(FAILURE_MARK.trimEnd())}`;
    case 'aborted':
      return ` ${chalk.hex(color)(CANCELLED_MARK.trimEnd())}`;
    case 'working':
    case 'suspended':
      return ACTIVITY_SPINNER_PLACEHOLDER;
  }
}

function statusBarCounts(members: readonly AgentSwarmMember[]): StatusBarCount[] {
  const counts = new Map<StatusBarPhase, number>();
  for (const member of members) {
    const phase = statusBarPhase(member.phase);
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  return STATUS_BAR_ORDER.flatMap((phase) => {
    const count = counts.get(phase) ?? 0;
    return count > 0 ? [{ phase, count }] : [];
  });
}

function statusBarPhase(phase: AgentSwarmPhase): StatusBarPhase {
  switch (phase) {
    case 'pending':
    case 'queued':
      return 'queued';
    case 'suspended':
      return 'suspended';
    case 'running':
      return 'working';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function statusBarColor(phase: StatusBarPhase, colors: ColorPalette): string {
  switch (phase) {
    case 'queued':
      return colors.textMuted;
    case 'working':
      return colors.primary;
    case 'suspended':
      return colors.warning;
    case 'completed':
      return colors.success;
    case 'failed':
      return colors.error;
    case 'cancelled':
      return colors.warning;
  }
}

function totalStatus(
  members: readonly AgentSwarmMember[],
  force: { readonly failed: boolean; readonly aborted: boolean },
): TotalStatus {
  if (force.aborted) return 'aborted';
  if (force.failed && members.length === 0) return 'failed';
  const hasCompleted = members.some((member) => member.phase === 'completed');
  const hasFailed = members.some((member) => member.phase === 'failed');
  const hasCancelled = members.some((member) => member.phase === 'cancelled');
  const hasSuspended = members.some((member) => member.phase === 'suspended');
  const hasRunning = members.some((member) => member.phase === 'running');
  const hasActive = members.some((member) =>
    (
      member.phase === 'pending' ||
      member.phase === 'queued' ||
      member.phase === 'suspended' ||
      member.phase === 'running'
    )
  );
  if (!hasActive && members.length > 0) {
    if (hasCancelled) return 'aborted';
    if (hasCompleted) return 'completed';
    if (hasFailed || force.failed) return 'failed';
  }
  if (force.failed) return 'failed';
  if (hasSuspended && !hasRunning) return 'suspended';
  return hasCancelled && !hasActive ? 'aborted' : 'working';
}

function totalStatusLabel(status: TotalStatus): string {
  switch (status) {
    case 'working':
      return WORKING_LABEL;
    case 'completed':
      return COMPLETED_LABEL;
    case 'suspended':
      return SUSPENDED_LABEL;
    case 'failed':
      return FAILED_LABEL;
    case 'aborted':
      return ABORTED_LABEL;
  }
}

function totalStatusColor(status: TotalStatus, colors: ColorPalette): string {
  switch (status) {
    case 'working':
      return colors.success;
    case 'completed':
      return colors.success;
    case 'suspended':
      return colors.warning;
    case 'failed':
      return colors.error;
    case 'aborted':
      return colors.warning;
  }
}

function totalStatusLabelColor(
  status: TotalStatus,
  members: readonly AgentSwarmMember[],
  colors: ColorPalette,
): string {
  if (status === 'working' && !members.some((member) => member.phase === 'completed')) {
    return colors.primary;
  }
  return totalStatusColor(status, colors);
}

function allocateSegmentWidths(counts: readonly number[], width: number): number[] {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total <= 0 || width <= 0) return counts.map(() => 0);

  const exact = counts.map((count) => count * width / total);
  const widths = exact.map(Math.floor);
  let remaining = width - widths.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .toSorted((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const entry of order) {
    if (remaining <= 0) break;
    widths[entry.index] = (widths[entry.index] ?? 0) + 1;
    remaining -= 1;
  }
  return widths;
}

function renderCellLabel(
  member: AgentSwarmMember,
  snapshot: AgentSwarmSnapshot,
  width: number,
  colors: ColorPalette,
): string {
  const latestLine = latestNonEmptyLine(snapshot.latestModelText);
  if (snapshot.phase === 'running') {
    const itemText = collapseWhitespace(member.itemText);
    const text = latestLine.length > 0 ? latestLine : itemText;
    if (text.length > 0) return truncateWithColor(text, width, colors.textDim);
  }
  if (snapshot.phase === 'failed' && member.failureText !== undefined) {
    return truncateWithColor(`${FAILURE_MARK}${member.failureText}`, width, colors.error);
  }
  if (snapshot.phase === 'completed') {
    return renderCompletedCellLabel(member.completedText ?? latestLine, width, colors);
  }
  if (snapshot.phase === 'cancelled') {
    return truncateWithColor(
      `${CANCELLED_MARK}${PHASE_LABELS[snapshot.phase]}`,
      width,
      colors.warning,
    );
  }
  return truncateWithColor(PHASE_LABELS[snapshot.phase], width, phaseColor(snapshot.phase, colors));
}

function renderCompletedCellLabel(
  text: string,
  width: number,
  colors: ColorPalette,
): string {
  const finalText = normalizeFinalOutputText(text);
  const label = finalText === undefined ? SUCCESS_MARK.trimEnd() : `${SUCCESS_MARK}${finalText}`;
  return truncateWithColor(label, width, colors.success);
}

function compactTerminalMark(phase: AgentSwarmPhase, colors: ColorPalette): string {
  switch (phase) {
    case 'completed':
      return chalk.hex(colors.success)(SUCCESS_MARK.trimEnd());
    case 'failed':
      return chalk.hex(colors.error)(FAILURE_MARK.trimEnd());
    case 'cancelled':
      return chalk.hex(colors.warning)(CANCELLED_MARK.trimEnd());
    case 'pending':
    case 'queued':
    case 'running':
    case 'suspended':
      return '';
  }
}

function renderPendingCell(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const id = chalk.hex(colors.primary)(member.id);
  const prefix = `${id} `;
  const itemText = collapseWhitespace(member.itemText);
  const label = itemText.length > 0 ? itemText : QUEUED_LABEL;
  const labelWidth = Math.max(1, width - visibleWidth(prefix));
  return prefix + truncateWithColor(label, labelWidth, colors.textDim);
}

function renderQueuedCell(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const id = chalk.hex(colors.primary)(member.id);
  const prefix = `${id} `;
  const labelWidth = Math.max(1, width - visibleWidth(prefix));
  return prefix + truncateWithColor(QUEUED_LABEL, labelWidth, colors.textDim);
}

function truncateWithColor(text: string, width: number, color: string): string {
  const colorize = chalk.hex(color);
  return truncateToWidth(colorize(text), width, colorize('…'));
}

function truncateStartToWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const ellipsis = '…';
  const ellipsisWidth = visibleWidth(ellipsis);
  if (width <= ellipsisWidth) return truncateToWidth(ellipsis, width);

  const targetWidth = width - ellipsisWidth;
  const segments = Array.from(text);
  let tail = '';
  let tailWidth = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] ?? '';
    const segmentWidth = visibleWidth(segment);
    if (tailWidth + segmentWidth > targetWidth) break;
    tail = segment + tail;
    tailWidth += segmentWidth;
  }
  return ellipsis + tail;
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function normalizeFailureText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const nestedFailureText = nestedAgentSwarmFailureText(text);
  const normalized = stripAgentSwarmPrefix(collapseWhitespace(nestedFailureText ?? text));
  return normalized.length > 0 ? normalized : undefined;
}

function nestedAgentSwarmFailureText(text: string): string | undefined {
  const xmlFailureText = nestedAgentSwarmXmlFailureText(text);
  if (xmlFailureText !== undefined) return nestedAgentSwarmFailureText(xmlFailureText) ?? xmlFailureText;

  if (!/^\s*agent_swarm:\s*failed\b/m.test(text)) return undefined;
  const match = /^\s*subagent error:\s*([\s\S]*?)(?=\n\[agent \d+\]\n|$)/m.exec(text);
  if (match === null) return undefined;
  const failureText = match[1];
  if (failureText === undefined) return undefined;
  return nestedAgentSwarmFailureText(failureText) ?? failureText;
}

function nestedAgentSwarmXmlFailureText(text: string): string | undefined {
  if (!/<agent_swarm_result\b/.test(text)) return undefined;
  const failed = parseAgentSwarmXmlResultStatuses(text).find((entry) => {
    return entry.status === 'failed' && entry.failureText !== undefined;
  });
  return failed?.failureText;
}

function stripAgentSwarmPrefix(text: string): string {
  return text.replace(/^agent_swarm:\s*(?:failed|completed)?\s*/i, '').trim();
}

function normalizeFinalOutputText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const normalized = collapseWhitespace(text);
  return normalized.length > 0 ? normalized : undefined;
}

function latestNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = collapseWhitespace(lines[index] ?? '');
    if (line.length > 0) return line;
  }
  return '';
}

function countPartialJsonObjectEntries(text: string, startIndex: number): number {
  let count = 0;
  let expectKey = true;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '}') return count;
    if (ch === ',') {
      expectKey = true;
      continue;
    }
    if (ch !== '"') continue;

    const parsed = parsePartialJsonString(text, i + 1);
    if (expectKey) {
      if (parsed.closed || parsed.value.length > 0) count += 1;
      expectKey = false;
    }
    if (!parsed.closed) return count;
    i = parsed.nextIndex;
  }
  return count;
}

function parsePartialJsonString(
  text: string,
  startIndex: number,
): { value: string; closed: boolean; nextIndex: number } {
  let value = '';
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') return { value, closed: true, nextIndex: i };
    if (ch !== '\\') {
      value += ch;
      continue;
    }

    const escaped = text[i + 1];
    if (escaped === undefined) return { value, closed: false, nextIndex: i };
    switch (escaped) {
      case 'n':
        value += '\n';
        i += 1;
        break;
      case 't':
        value += '\t';
        i += 1;
        break;
      case 'r':
        value += '\r';
        i += 1;
        break;
      case 'b':
        value += '\b';
        i += 1;
        break;
      case 'f':
        value += '\f';
        i += 1;
        break;
      case '"':
      case '\\':
      case '/':
        value += escaped;
        i += 1;
        break;
      case 'u': {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) return { value, closed: false, nextIndex: i };
        const code = Number.parseInt(hex, 16);
        if (Number.isNaN(code)) return { value, closed: false, nextIndex: i };
        value += String.fromCodePoint(code);
        i += 5;
        break;
      }
      default:
        value += escaped;
        i += 1;
    }
  }
  return { value, closed: false, nextIndex: text.length };
}

function padAnsi(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + ' '.repeat(Math.max(0, width - visibleWidth(truncated)));
}

function completedDisplayTicks(ticks: number, width: number, phaseElapsedMs: number): number {
  const fullBarTicks = width * BRAILLE_LEVELS.length;
  if (ticks >= fullBarTicks) return fullBarTicks;
  const fillProgress = Math.max(0, Math.min(1, phaseElapsedMs / COMPLETE_FILL_MS));
  return Math.min(fullBarTicks, Math.ceil(ticks + (fullBarTicks - ticks) * fillProgress));
}

function failedBrailleBar(
  ticks: number,
  width: number,
  phaseElapsedMs: number,
  colors: ColorPalette,
): string {
  const redCellCount = Math.ceil(
    completedDisplayTicks(ticks, width, phaseElapsedMs) / BRAILLE_LEVELS.length,
  );
  const placeholderColor = darkenRedHexColor(colors.error);
  return accumulatedBrailleBar(
    ticks,
    width,
    colors.error,
    colors,
    (cellIndex) => cellIndex < redCellCount ? placeholderColor : colors.textDim,
  );
}

function darkenRedHexColor(hex: string): string {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (match === null) return hex;
  const [, red = '00', green = '00', blue = '00'] = match;
  const darken = (channel: string, factor: number): string => {
    const value = Math.max(0, Math.min(255, Math.round(Number.parseInt(channel, 16) * factor)));
    return value.toString(16).padStart(2, '0');
  };
  return `#${darken(red, FAILED_PLACEHOLDER_RED_FACTOR)}${darken(
    green,
    FAILED_PLACEHOLDER_NON_RED_FACTOR,
  )}${darken(blue, FAILED_PLACEHOLDER_NON_RED_FACTOR)}`;
}

function accumulatedBrailleBar(
  ticks: number,
  width: number,
  filledColor: string,
  colors: ColorPalette,
  emptyColorForCell?: (cellIndex: number) => string,
): string {
  const dotsPerCell = BRAILLE_LEVELS.length;
  const cycleSize = width * dotsPerCell;
  const safeTicks = Math.max(0, Math.ceil(ticks));
  const completedCycles = Math.floor(safeTicks / cycleSize);
  const cycleTicks = safeTicks % cycleSize;
  const activeCells = cycleTicks === 0 ? 0 : Math.ceil(cycleTicks / dotsPerCell);
  const separatorIndex = completedCycles > 0 && activeCells > 0 && activeCells < width
    ? activeCells
    : -1;

  let out = '';
  let pending = '';
  let pendingColor: string | undefined;
  const flush = (): void => {
    if (pending.length === 0 || pendingColor === undefined) return;
    out += chalk.hex(pendingColor)(pending);
    pending = '';
  };
  const append = (char: string, color: string): void => {
    if (pendingColor !== color) {
      flush();
      pendingColor = color;
    }
    pending += char;
  };

  for (let i = 0; i < width; i += 1) {
    if (i === separatorIndex) {
      append(BRAILLE_RIGHT_COLUMN_FULL, filledColor);
      continue;
    }

    const cellStart = i * dotsPerCell;
    const countThisCycle = Math.max(0, Math.min(dotsPerCell, cycleTicks - cellStart));
    const count = countThisCycle > 0 ? countThisCycle : completedCycles > 0 ? dotsPerCell : 0;
    append(
      count === 0 ? BRAILLE_EMPTY : BRAILLE_LEVELS[count - 1]!,
      count === 0 ? emptyColorForCell?.(i) ?? colors.textDim : filledColor,
    );
  }
  flush();
  return out;
}
