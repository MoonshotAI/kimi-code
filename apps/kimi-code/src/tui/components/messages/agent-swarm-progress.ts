import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

const MIN_CELL_WIDTH = 32;
const CELL_GAP = '  ';
const BRAILLE_BAR_MIN_WIDTH = 8;
const BRAILLE_BAR_MAX_WIDTH = 24;
const BRAILLE_EMPTY = '⣀';
const BRAILLE_RIGHT_COLUMN_FULL = '⢸';
const BRAILLE_LEVELS = ['⡀', '⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;
const PHASE_LABEL_WIDTH = 'Completed'.length;

type AgentSwarmPhase = 'spawning' | 'working' | 'completed' | 'failed';

interface AgentSwarmMember {
  readonly index: number;
  readonly id: string;
  agentId?: string;
  phase: AgentSwarmPhase;
  ticks: number;
}

interface AgentSwarmSnapshot {
  readonly phase: AgentSwarmPhase;
  readonly ticks: number;
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
  readonly items: readonly string[];
  readonly colors: ColorPalette;
}

const PHASE_LABELS: Record<AgentSwarmPhase, string> = {
  spawning: 'Spawning',
  working: 'Working',
  completed: 'Completed',
  failed: 'Failed',
};

export class AgentSwarmProgressComponent implements Component {
  private readonly members: AgentSwarmMember[];
  private readonly seenToolCalls = new Set<string>();
  private readonly description: string;
  private readonly colors: ColorPalette;

  constructor(options: AgentSwarmProgressOptions) {
    this.description = options.description;
    this.colors = options.colors;
    const safeItems = options.items.length > 0 ? options.items : ['agent'];
    this.members = safeItems.map((_item, index) => ({
      index,
      id: `swarm-${String(index + 1).padStart(3, '0')}`,
      phase: 'spawning',
      ticks: 0,
    }));
  }

  invalidate(): void {}

  registerSubagent(input: {
    readonly agentId: string;
    readonly description?: string | undefined;
  }): void {
    const member = this.findMemberForSubagent(input.agentId, input.description);
    if (member === undefined) return;
    member.agentId = input.agentId;
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
    if (member.phase === 'spawning') member.phase = 'working';
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
      const member = this.members[entry.index - 1];
      if (member === undefined) continue;
      member.phase = entry.status;
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width);
    const snapshots = this.members.map((member): AgentSwarmSnapshot => ({
      phase: member.phase,
      ticks: member.ticks,
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

  private renderHeader(width: number, summary: AgentSwarmSummary): string {
    const title = chalk.hex(this.colors.primary).bold(' Agent swarm');
    const description =
      this.description.length > 0
        ? chalk.hex(this.colors.text)(`: ${this.description}`)
        : '';
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
    const status = PHASE_LABELS[snapshot.phase];
    const fixedWidth = member.id.length + 2 + PHASE_LABEL_WIDTH + 1;
    const availableForBar = width - fixedWidth - 2;
    const barWidth =
      availableForBar >= BRAILLE_BAR_MIN_WIDTH
        ? Math.min(BRAILLE_BAR_MAX_WIDTH, availableForBar)
        : Math.max(1, availableForBar);
    const id = chalk.hex(this.colors.textDim)(`${member.id}:`);
    return [
      id,
      stylePhase(status.padStart(PHASE_LABEL_WIDTH), snapshot.phase, this.colors),
      brailleBar(snapshot.ticks, snapshot.phase, barWidth, this.colors),
    ].join(' ');
  }

  private findMemberForSubagent(
    agentId: string,
    description: string | undefined,
  ): AgentSwarmMember | undefined {
    const existing = this.findMemberByAgentId(agentId);
    if (existing !== undefined) return existing;

    const index = parseAgentSwarmDescriptionIndex(description);
    if (index !== undefined) {
      const byDescription = this.members[index - 1];
      if (byDescription !== undefined) return byDescription;
    }

    return this.members.find((member) => member.agentId === undefined);
  }

  private findMemberByAgentId(agentId: string): AgentSwarmMember | undefined {
    return this.members.find((member) => member.agentId === agentId);
  }
}

export function agentSwarmItemsFromArgs(args: Record<string, unknown>): string[] {
  const items = args['items'];
  if (!Array.isArray(items)) return [];
  return items.map(String);
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
): string {
  const innerWidth = Math.max(1, width);
  const fillColor = phase === 'failed' ? colors.error : colors.success;
  return bracketBar(accumulatedBrailleBar(ticks, innerWidth, fillColor, colors), colors);
}

function bracketBar(content: string, colors: ColorPalette): string {
  const bracket = chalk.hex(colors.textMuted);
  return bracket('[') + content + bracket(']');
}

function stylePhase(label: string, phase: AgentSwarmPhase, colors: ColorPalette): string {
  switch (phase) {
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

function padAnsi(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + ' '.repeat(Math.max(0, width - visibleWidth(truncated)));
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
