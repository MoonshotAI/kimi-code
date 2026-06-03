import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

const MIN_CELL_WIDTH = 32;
const CELL_GAP = '  ';
const FRAME_INTERVAL_MS = 80;
const BRAILLE_BAR_MIN_WIDTH = 8;
const BRAILLE_BAR_MAX_WIDTH = 24;
const BRAILLE_EMPTY = '⣀';
const BRAILLE_SPAWNING_RIGHT = '⣷';
const BRAILLE_SPAWNING_LEFT = '⣾';
const BRAILLE_RIGHT_COLUMN_FULL = '⢸';
const BRAILLE_LEVELS = ['⡀', '⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;
const PHASE_LABEL_WIDTH = 'Completed'.length;
const MIN_LABEL_WIDTH = PHASE_LABEL_WIDTH;
const MAX_LATEST_ASSISTANT_CHARS = 1_000;
const ORCHESTRATING_LABEL = 'Orchestrating...';
const SPAWNING_LABEL = 'Spawning...';

type AgentSwarmPhase = 'pending' | 'spawning' | 'working' | 'completed' | 'failed';

interface AgentSwarmMember {
  readonly index: number;
  readonly id: string;
  agentId?: string;
  phase: AgentSwarmPhase;
  ticks: number;
  itemText: string;
  latestAssistantText: string;
}

interface AgentSwarmSnapshot {
  readonly phase: AgentSwarmPhase;
  readonly ticks: number;
  readonly latestAssistantText: string;
}

interface AgentSwarmResultStatus {
  readonly index: number;
  readonly status: 'completed' | 'failed';
}

interface AgentSwarmSummary {
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
}

export interface AgentSwarmProgressOptions {
  readonly description: string;
  readonly colors: ColorPalette;
  readonly requestRender?: () => void;
}

const PHASE_LABELS: Record<AgentSwarmPhase, string> = {
  pending: 'Spawning',
  spawning: 'Spawning',
  working: 'Working',
  completed: 'Completed',
  failed: 'Failed',
};

export class AgentSwarmProgressComponent implements Component {
  private members: AgentSwarmMember[];
  private readonly seenToolCalls = new Set<string>();
  private description: string;
  private readonly colors: ColorPalette;
  private readonly requestRender: (() => void) | undefined;
  private inputComplete = false;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AgentSwarmProgressOptions) {
    this.description = options.description;
    this.colors = options.colors;
    this.requestRender = options.requestRender;
    this.members = [];
  }

  dispose(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {}

  updateArgs(
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined } = {},
  ): void {
    const description = agentSwarmDescriptionFromArgs(args);
    if (description.length > 0 || this.description.length === 0) {
      this.description = description;
    }
    const fullItemsCount = agentSwarmItemsFromArgs(args).length;
    const partialItems =
      options.streamingArguments === undefined
        ? []
        : agentSwarmPartialItemsFromArguments(options.streamingArguments);
    const fullItems = agentSwarmItemsFromArgs(args);
    const itemCount = Math.max(fullItemsCount, partialItems.length);
    if (itemCount > 0) this.ensureMemberCount(itemCount);
    this.updateItemTexts(fullItems, partialItems);
  }

  markInputComplete(): void {
    if (!this.inputComplete) {
      this.inputComplete = true;
      for (const member of this.members) {
        if (member.phase === 'pending') member.phase = 'spawning';
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
    if (this.inputComplete && member.phase === 'pending') member.phase = 'spawning';
    this.startAnimationIfNeeded();
  }

  recordToolCall(input: {
    readonly agentId: string;
    readonly toolCallId: string;
  }): void {
    const key = `${input.agentId}:${input.toolCallId}`;
    if (this.seenToolCalls.has(key)) return;
    this.seenToolCalls.add(key);
    const member = this.findMemberByAgentId(input.agentId);
    if (member === undefined) return;
    member.ticks += 1;
    if (member.phase === 'pending' || member.phase === 'spawning') member.phase = 'working';
  }

  appendAssistantDelta(input: {
    readonly agentId: string;
    readonly delta: string;
  }): void {
    const member = this.findMemberByAgentId(input.agentId);
    if (member === undefined || input.delta.length === 0) return;
    if (member.latestAssistantText.length >= MAX_LATEST_ASSISTANT_CHARS) return;
    member.latestAssistantText = `${member.latestAssistantText}${input.delta}`.slice(
      0,
      MAX_LATEST_ASSISTANT_CHARS,
    );
  }

  markCompleted(agentId: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined || member.phase === 'failed') return;
    member.phase = 'completed';
  }

  markFailed(agentId: string): void {
    const member = this.findMemberByAgentId(agentId);
    if (member === undefined) return;
    member.phase = 'failed';
  }

  applyResult(output: string): void {
    for (const entry of parseAgentSwarmResultStatuses(output)) {
      this.ensureMemberCount(entry.index);
      const member = this.members[entry.index - 1];
      if (member === undefined) continue;
      member.phase = entry.status;
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width);
    if (this.members.length === 0) {
      const lines = [
        this.renderHeader(innerWidth, undefined),
        chalk.hex(this.colors.primary)('─'.repeat(innerWidth)),
        '',
        chalk.hex(this.colors.textMuted)(` ${ORCHESTRATING_LABEL}`),
        '',
        chalk.hex(this.colors.primary)('─'.repeat(innerWidth)),
      ];
      return lines.map((line) => truncateToWidth(line, innerWidth));
    }

    const snapshots = this.members.map((member): AgentSwarmSnapshot => ({
      phase: member.phase,
      ticks: member.ticks,
      latestAssistantText: member.latestAssistantText,
    }));
    const summary = summarizeSnapshots(snapshots);
    const lines = [
      this.renderHeader(innerWidth, summary),
      chalk.hex(this.colors.primary)('─'.repeat(innerWidth)),
      '',
      ...this.renderGrid(innerWidth, snapshots),
      '',
      chalk.hex(this.colors.primary)('─'.repeat(innerWidth)),
    ];
    return lines.map((line) => truncateToWidth(line, innerWidth));
  }

  private renderHeader(width: number, summary: AgentSwarmSummary | undefined): string {
    const title = chalk.hex(this.colors.primary).bold(' Agent swarm');
    const description =
      this.description.length > 0
        ? chalk.hex(this.colors.text)(`: ${this.description}`)
        : '';
    if (summary === undefined) return truncateToWidth(title + description, width);
    const count = chalk.hex(this.colors.textMuted)(` agents=${String(this.members.length)}`);
    const activeLabel = chalk.hex(this.colors.accent)(` running=${String(summary.active)}`);
    const doneLabel = chalk.hex(this.colors.success)(` complete=${String(summary.completed)}`);
    const failedLabel = chalk.hex(this.colors.error)(` failed=${String(summary.failed)}`);
    return truncateToWidth(
      title + description + count + activeLabel + doneLabel + failedLabel,
      width,
    );
  }

  private renderGrid(width: number, snapshots: readonly AgentSwarmSnapshot[]): string[] {
    const columns = columnsForWidth(width, this.members.length);
    const gapWidth = visibleWidth(CELL_GAP);
    const cellWidth = Math.max(
      1,
      Math.floor((width - gapWidth * Math.max(0, columns - 1)) / columns),
    );
    const rows = Math.ceil(this.members.length / columns);
    const lines: string[] = [];

    for (let row = 0; row < rows; row += 1) {
      const cells: string[] = [];
      for (let col = 0; col < columns; col += 1) {
        const index = row * columns + col;
        const member = this.members[index];
        const snapshot = snapshots[index];
        if (member === undefined || snapshot === undefined) continue;
        cells.push(padAnsi(this.renderCell(member, snapshot, cellWidth), cellWidth));
      }
      lines.push(cells.join(CELL_GAP));
    }
    return lines;
  }

  private renderCell(member: AgentSwarmMember, snapshot: AgentSwarmSnapshot, width: number): string {
    if (snapshot.phase === 'pending') {
      return renderPendingCell(member, width, this.colors);
    }

    const fixedWidth = member.id.length + 1 + 2 + 1 + MIN_LABEL_WIDTH;
    const availableForBar = width - fixedWidth - 2;
    const barWidth =
      availableForBar >= BRAILLE_BAR_MIN_WIDTH
        ? Math.min(BRAILLE_BAR_MAX_WIDTH, availableForBar)
        : Math.max(1, availableForBar);
    const id = chalk.hex(this.colors.textDim)(member.id);
    const bar = brailleBar(
      snapshot.ticks,
      snapshot.phase,
      barWidth,
      this.colors,
      this.frame,
      member.index,
    );
    const prefix = `${id} ${bar} `;
    const labelWidth = Math.max(1, width - visibleWidth(prefix));
    const label = renderCellLabel(snapshot, labelWidth, this.colors);
    return prefix + label;
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
    this.members = [
      ...this.members,
      ...createMembers(count, this.inputComplete ? 'spawning' : 'pending').slice(this.members.length),
    ];
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
      if (!this.hasAnimatedMembers()) {
        this.dispose();
        return;
      }
      this.frame += 1;
      requestRender();
    }, FRAME_INTERVAL_MS);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  private hasAnimatedMembers(): boolean {
    return this.members.some((member) => member.phase === 'spawning');
  }
}

function createMembers(count: number, phase: AgentSwarmPhase): AgentSwarmMember[] {
  return Array.from({ length: count }, (_item, index) => ({
    index,
    id: String(index + 1).padStart(2, '0'),
    phase,
    ticks: 0,
    itemText: '',
    latestAssistantText: '',
  }));
}

export function agentSwarmItemsFromArgs(args: Record<string, unknown>): string[] {
  const items = args['items'];
  if (!Array.isArray(items)) return [];
  return items.map(String);
}

export function agentSwarmPartialItemsCountFromArguments(argumentsText: string): number {
  return agentSwarmPartialItemsFromArguments(argumentsText).length;
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

export function agentSwarmDescriptionFromArgs(args: Record<string, unknown>): string {
  const description = args['description'];
  return typeof description === 'string' ? description : '';
}

function parseAgentSwarmDescriptionIndex(description: string | undefined): number | undefined {
  if (description === undefined) return undefined;
  const match = /#(\d+)(?:\s|$|\()/.exec(description);
  if (match === null) return undefined;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : undefined;
}

function parseAgentSwarmResultStatuses(output: string): AgentSwarmResultStatus[] {
  const result: AgentSwarmResultStatus[] = [];
  const blocks = output.split(/\n(?=\[agent \d+\]\n)/);
  for (const block of blocks) {
    const indexMatch = /^\[agent (\d+)\]$/m.exec(block);
    const statusMatch = /^status: (completed|failed)$/m.exec(block);
    if (indexMatch === null || statusMatch === null) continue;
    result.push({
      index: Number(indexMatch[1]),
      status: statusMatch[1] as 'completed' | 'failed',
    });
  }
  return result;
}

function columnsForWidth(width: number, count: number): number {
  if (count <= 1) return 1;
  const gapWidth = visibleWidth(CELL_GAP);
  const columns = Math.floor((width + gapWidth) / (MIN_CELL_WIDTH + gapWidth));
  return Math.max(1, Math.min(count, columns));
}

function summarizeSnapshots(snapshots: readonly AgentSwarmSnapshot[]): AgentSwarmSummary {
  let completed = 0;
  let failed = 0;
  for (const snapshot of snapshots) {
    if (snapshot.phase === 'completed') completed += 1;
    if (snapshot.phase === 'failed') failed += 1;
  }
  return {
    active: snapshots.length - completed - failed,
    completed,
    failed,
  };
}

function brailleBar(
  ticks: number,
  phase: AgentSwarmPhase,
  width: number,
  colors: ColorPalette,
  frame: number,
  memberIndex: number,
): string {
  const innerWidth = Math.max(1, width);
  switch (phase) {
    case 'pending':
      return '';
    case 'spawning':
      return bracketBar(spawningBrailleBar(innerWidth, frame, memberIndex, colors), colors);
    case 'working':
      return bracketBar(accumulatedBrailleBar(ticks, innerWidth, colors.success, colors), colors);
    case 'completed':
      return bracketBar(accumulatedBrailleBar(ticks, innerWidth, colors.success, colors), colors);
    case 'failed':
      return bracketBar(accumulatedBrailleBar(ticks, innerWidth, colors.error, colors), colors);
  }
}

function bracketBar(content: string, colors: ColorPalette): string {
  const bracket = chalk.hex(colors.textMuted);
  return bracket('[') + content + bracket(']');
}

function stylePhase(label: string, phase: AgentSwarmPhase, colors: ColorPalette): string {
  switch (phase) {
    case 'pending':
      return chalk.hex(colors.textDim)(label);
    case 'spawning':
      return chalk.hex(colors.textDim)(label);
    case 'working':
      return chalk.hex(colors.primary)(label);
    case 'completed':
      return chalk.hex(colors.success)(label);
    case 'failed':
      return chalk.hex(colors.error)(label);
  }
}

function renderCellLabel(
  snapshot: AgentSwarmSnapshot,
  width: number,
  colors: ColorPalette,
): string {
  const assistantText = collapseWhitespace(snapshot.latestAssistantText);
  if (snapshot.phase === 'working' && assistantText.length > 0) {
    return chalk.hex(colors.text)(truncateToWidth(assistantText, width, '…'));
  }
  return stylePhase(truncateToWidth(PHASE_LABELS[snapshot.phase], width, '…'), snapshot.phase, colors);
}

function renderPendingCell(
  member: AgentSwarmMember,
  width: number,
  colors: ColorPalette,
): string {
  const id = chalk.hex(colors.textDim)(member.id);
  const prefix = `${id} `;
  const itemText = collapseWhitespace(member.itemText);
  const label = itemText.length > 0 ? itemText : SPAWNING_LABEL;
  const labelColor = itemText.length > 0 ? colors.text : colors.textDim;
  const labelWidth = Math.max(1, width - visibleWidth(prefix));
  return prefix + chalk.hex(labelColor)(truncateToWidth(label, labelWidth, '…'));
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
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

function spawningBrailleBar(
  width: number,
  frame: number,
  memberIndex: number,
  colors: ColorPalette,
): string {
  if (width <= 1) {
    return chalk.hex(colors.textMuted)(BRAILLE_SPAWNING_RIGHT);
  }
  let out = '';
  const maxPosition = width - 1;
  const period = maxPosition * 2;
  const position = (frame + memberIndex) % period;
  const movingRight = position <= maxPosition;
  const cursorCell = movingRight ? position : period - position;
  const cursorChar = movingRight ? BRAILLE_SPAWNING_RIGHT : BRAILLE_SPAWNING_LEFT;
  for (let i = 0; i < width; i += 1) {
    out += chalk.hex(i === cursorCell ? colors.textMuted : colors.textDim)(
      i === cursorCell ? cursorChar : BRAILLE_EMPTY,
    );
  }
  return out;
}

function accumulatedBrailleBar(
  ticks: number,
  width: number,
  filledColor: string,
  colors: ColorPalette,
): string {
  const dotsPerCell = BRAILLE_LEVELS.length;
  const cycleSize = width * dotsPerCell;
  const safeTicks = Math.max(0, ticks);
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
      count === 0 ? colors.textDim : filledColor,
    );
  }
  flush();
  return out;
}
