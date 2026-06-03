import {
  Container,
  Key,
  matchesKey,
  ProcessTerminal,
  truncateToWidth,
  TUI,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { CHROME_GUTTER } from './constant/rendering';
import { GutterContainer } from './components/chrome/gutter-container';
import { loadTuiConfig, TuiConfigParseError } from './config';
import { createKimiTUIThemeBundle } from './theme/bundle';
import type { ColorPalette } from './theme/colors';
import { detectTerminalTheme } from './theme/detect';
import { printableChar } from './utils/printable-key';

const DEFAULT_SWARM_COUNT = 32;
const MAX_SWARM_COUNT = 256;
const FRAME_INTERVAL_MS = 80;
const MIN_CELL_WIDTH = 32;
const CELL_GAP = '  ';
const BRAILLE_BAR_MIN_WIDTH = 8;
const BRAILLE_BAR_MAX_WIDTH = 24;
const BRAILLE_EMPTY = '⣀';
const BRAILLE_SPAWNING_RIGHT = '⣷';
const BRAILLE_SPAWNING_LEFT = '⣾';
const BRAILLE_RIGHT_COLUMN_FULL = '⢸';
const BRAILLE_LEVELS = ['⡀', '⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const;
const NOMINAL_FULL_BAR_TICKS = BRAILLE_LEVELS.length * BRAILLE_BAR_MAX_WIDTH;
const PHASE_LABEL_WIDTH = 'Completed'.length;
const COMPLETE_FILL_MS = 360;
const LONG_SPAWNING_WAIT_MS = 30_000;
const FAILURE_COUNT = 2;

export interface SwarmDemoRunOptions {
  readonly count?: string;
}

interface SwarmDemoComponentOptions {
  readonly count: number;
  readonly colors: ColorPalette;
  readonly requestRender: () => void;
  readonly onExit: () => void;
}

type SwarmPhase = 'spawning' | 'working' | 'completed' | 'failed';

interface SwarmTask {
  readonly index: number;
  readonly id: string;
  readonly waitMs: number;
  readonly offsetMs: number;
  readonly shouldFail: boolean;
  readonly terminalTicks: number;
  readonly tickTimesMs: readonly number[];
}

interface SwarmSnapshot {
  readonly phase: SwarmPhase;
  readonly ticks: number;
  readonly phaseElapsedMs: number;
}

interface SwarmSummary {
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
}

const PHASE_LABELS: Record<SwarmPhase, string> = {
  spawning: 'Spawning',
  working: 'Working',
  completed: 'Completed',
  failed: 'Failed',
};

export async function runSwarmDemo(options: SwarmDemoRunOptions = {}): Promise<number> {
  const count = resolveSwarmCount(options.count);
  const colors = await loadSwarmDemoColors();
  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);
  let stopped = false;
  let resolveExit: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const component = new SwarmDemoComponent({
    count,
    colors,
    requestRender: () => {
      ui.requestRender();
    },
    onExit: () => {
      void stop(0);
    },
  });

  const root = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  root.addChild(component);
  ui.addChild(root);
  ui.setFocus(component);

  const cleanupHandlers: Array<() => void> = [];
  const addSignalHandler = (signal: NodeJS.Signals, code: number): void => {
    const handler = (): void => {
      void stop(code);
    };
    process.prependListener(signal, handler);
    cleanupHandlers.push(() => {
      process.off(signal, handler);
    });
  };
  addSignalHandler('SIGTERM', 143);
  if (process.platform !== 'win32') addSignalHandler('SIGHUP', 129);

  async function stop(code: number): Promise<void> {
    if (stopped) return;
    stopped = true;
    for (const cleanup of cleanupHandlers) cleanup();
    cleanupHandlers.length = 0;
    component.dispose();
    terminal.setProgress(false);
    await terminal.drainInput().catch(() => {});
    ui.stop();
    resolveExit(code);
  }

  try {
    terminal.setTitle('Kimi swarm demo');
    terminal.setProgress(true);
    ui.start();
    component.start();
    ui.requestRender(true);
  } catch (error) {
    component.dispose();
    for (const cleanup of cleanupHandlers) cleanup();
    cleanupHandlers.length = 0;
    terminal.setProgress(false);
    ui.stop();
    throw error;
  }

  return done;
}

export function resolveSwarmCount(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_SWARM_COUNT;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_SWARM_COUNT) {
    throw new Error(
      `Invalid swarm count "${raw}". Use an integer from 1 to ${String(MAX_SWARM_COUNT)}.`,
    );
  }
  return count;
}

async function loadSwarmDemoColors(): Promise<ColorPalette> {
  try {
    const config = await loadTuiConfig();
    const resolvedTheme = config.theme === 'auto' ? await detectTerminalTheme() : config.theme;
    return createKimiTUIThemeBundle(config.theme, resolvedTheme).colors;
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    const resolvedTheme =
      error.fallback.theme === 'auto' ? await detectTerminalTheme() : error.fallback.theme;
    return createKimiTUIThemeBundle(error.fallback.theme, resolvedTheme).colors;
  }
}

export class SwarmDemoComponent extends Container implements Focusable {
  focused = false;
  private readonly tasks: readonly SwarmTask[];
  private readonly colors: ColorPalette;
  private readonly requestRender: () => void;
  private readonly onExit: () => void;
  private startedAt = Date.now();
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SwarmDemoComponentOptions) {
    super();
    this.colors = options.colors;
    this.requestRender = options.requestRender;
    this.onExit = options.onExit;
    this.tasks = createSwarmTasks(options.count);
  }

  start(): void {
    this.dispose();
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      this.frame += 1;
      this.requestRender();
    }, FRAME_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  handleInput(data: string): void {
    const printable = printableChar(data);
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d')) ||
      printable === 'q' ||
      printable === 'Q'
    ) {
      this.onExit();
    }
  }

  override render(width: number): string[] {
    const innerWidth = Math.max(1, width);
    const elapsedMs = Date.now() - this.startedAt;
    const snapshots = this.tasks.map((task) => snapshotTask(task, elapsedMs));
    const summary = summarizeSnapshots(snapshots);
    const lines: string[] = [
      this.renderHeader(innerWidth, summary),
      chalk.hex(this.colors.textMuted)(' q / Esc / Ctrl-C exit'),
      chalk.hex(this.colors.primary)('─'.repeat(innerWidth)),
      '',
      ...this.renderGrid(innerWidth, snapshots),
      '',
      chalk.hex(this.colors.primary)('─'.repeat(innerWidth)),
    ];
    return lines.map((line) => truncateToWidth(line, innerWidth));
  }

  private renderHeader(width: number, summary: SwarmSummary): string {
    const title = chalk.hex(this.colors.primary).bold(' Kimi swarm demo');
    const count = chalk.hex(this.colors.textMuted)(` swarms=${String(this.tasks.length)}`);
    const activeLabel = chalk.hex(this.colors.accent)(` running=${String(summary.active)}`);
    const doneLabel = chalk.hex(this.colors.success)(` complete=${String(summary.completed)}`);
    const failedLabel = chalk.hex(this.colors.error)(` failed=${String(summary.failed)}`);
    return truncateToWidth(title + count + activeLabel + doneLabel + failedLabel, width);
  }

  private renderGrid(width: number, snapshots: readonly SwarmSnapshot[]): string[] {
    const columns = columnsForWidth(width, this.tasks.length);
    const gapWidth = visibleWidth(CELL_GAP);
    const cellWidth = Math.max(
      1,
      Math.floor((width - gapWidth * Math.max(0, columns - 1)) / columns),
    );
    const rows = Math.ceil(this.tasks.length / columns);
    const lines: string[] = [];

    for (let row = 0; row < rows; row += 1) {
      const cells: string[] = [];
      for (let col = 0; col < columns; col += 1) {
        const index = row * columns + col;
        const task = this.tasks[index];
        const snapshot = snapshots[index];
        if (task === undefined || snapshot === undefined) continue;
        cells.push(padAnsi(this.renderCell(task, snapshot, cellWidth), cellWidth));
      }
      lines.push(cells.join(CELL_GAP));
    }
    return lines;
  }

  private renderCell(task: SwarmTask, snapshot: SwarmSnapshot, width: number): string {
    const status = PHASE_LABELS[snapshot.phase];
    const fixedWidth = task.id.length + 2 + PHASE_LABEL_WIDTH + 1;
    const availableForBar = width - fixedWidth - 2;
    const barWidth =
      availableForBar >= BRAILLE_BAR_MIN_WIDTH
        ? Math.min(BRAILLE_BAR_MAX_WIDTH, availableForBar)
        : Math.max(1, availableForBar);
    const id = chalk.hex(this.colors.textDim)(`${task.id}:`);
    return [
      id,
      stylePhase(status.padStart(PHASE_LABEL_WIDTH), snapshot.phase, this.colors),
      brailleBar(
        snapshot.ticks,
        snapshot.phase,
        barWidth,
        this.colors,
        this.frame,
        task.index,
        snapshot.phaseElapsedMs,
      ),
    ].join(' ');
  }
}

function createSwarmTasks(count: number): readonly SwarmTask[] {
  const failureIndexes = chooseFailureIndexes(count);
  return Array.from({ length: count }, (_, index) => {
    const shouldFail = failureIndexes.has(index);
    let terminalTicks: number;
    if (shouldFail) {
      terminalTicks = 8 + Math.floor(Math.random() * 9);
    } else if (Math.random() < 0.8) {
      terminalTicks = Math.floor(NOMINAL_FULL_BAR_TICKS * (0.35 + Math.random() * 0.45));
    } else {
      terminalTicks =
        NOMINAL_FULL_BAR_TICKS + 10 + Math.floor(Math.random() * NOMINAL_FULL_BAR_TICKS);
    }

    let waitMs = 250 + Math.floor(Math.random() * 1_100);
    if (index === 0) waitMs = LONG_SPAWNING_WAIT_MS;
    else if (shouldFail) waitMs = 120 + Math.floor(Math.random() * 360);

    return {
      index,
      id: `swarm-${String(index + 1).padStart(3, '0')}`,
      waitMs,
      offsetMs: index === 0 ? 0 : Math.floor(Math.random() * (shouldFail ? 250 : 900)),
      shouldFail,
      terminalTicks,
      tickTimesMs: createTickTimes(terminalTicks, shouldFail),
    };
  });
}

function snapshotTask(task: SwarmTask, elapsedMs: number): SwarmSnapshot {
  const elapsed = elapsedMs + task.offsetMs;
  if (elapsed < task.waitMs) {
    return { phase: 'spawning', ticks: 0, phaseElapsedMs: elapsed };
  }

  const workingElapsed = elapsed - task.waitMs;
  const ticks = ticksForElapsed(task.tickTimesMs, workingElapsed);
  if (ticks >= task.terminalTicks) {
    const terminalAtMs = task.tickTimesMs[task.terminalTicks - 1] ?? 0;
    return {
      phase: task.shouldFail ? 'failed' : 'completed',
      ticks: task.terminalTicks,
      phaseElapsedMs: Math.max(0, workingElapsed - terminalAtMs),
    };
  }
  return { phase: 'working', ticks, phaseElapsedMs: workingElapsed };
}

function summarizeSnapshots(snapshots: readonly SwarmSnapshot[]): SwarmSummary {
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

function columnsForWidth(width: number, count: number): number {
  if (count <= 1) return 1;
  const gapWidth = visibleWidth(CELL_GAP);
  const columns = Math.floor((width + gapWidth) / (MIN_CELL_WIDTH + gapWidth));
  return Math.max(1, Math.min(count, columns));
}

function brailleBar(
  ticks: number,
  phase: SwarmPhase,
  width: number,
  colors: ColorPalette,
  frame: number,
  taskIndex: number,
  phaseElapsedMs: number,
): string {
  const innerWidth = Math.max(1, width);
  switch (phase) {
    case 'spawning':
      return bracketBar(spawningBrailleBar(innerWidth, frame, taskIndex, colors), colors);
    case 'working':
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
      return bracketBar(accumulatedBrailleBar(ticks, innerWidth, colors.error, colors), colors);
  }
}

function bracketBar(content: string, colors: ColorPalette): string {
  const bracket = chalk.hex(colors.textMuted);
  return bracket('[') + content + bracket(']');
}

function stylePhase(label: string, phase: SwarmPhase, colors: ColorPalette): string {
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

function chooseFailureIndexes(count: number): ReadonlySet<number> {
  const target = Math.min(FAILURE_COUNT, count);
  const candidates =
    count > target
      ? Array.from({ length: count - 1 }, (_, index) => index + 1)
      : Array.from({ length: count }, (_, index) => index);
  const indexes = new Set<number>();
  while (indexes.size < target) {
    indexes.add(candidates[Math.floor(Math.random() * candidates.length)]!);
  }
  return indexes;
}

function createTickTimes(ticks: number, fastFailure: boolean): readonly number[] {
  const times: number[] = [];
  let elapsed = 0;
  for (let i = 0; i < ticks; i += 1) {
    elapsed += fastFailure ? randomFailureTickIntervalMs() : randomTickIntervalMs();
    times.push(elapsed);
  }
  return times;
}

function randomFailureTickIntervalMs(): number {
  return 50 + Math.floor(Math.random() * 120);
}

function randomTickIntervalMs(): number {
  const roll = Math.random();
  if (roll < 0.5) return 30 + Math.floor(Math.random() * 140);
  if (roll < 0.8) return 170 + Math.floor(Math.random() * 480);
  if (roll < 0.95) return 650 + Math.floor(Math.random() * 1_150);
  return 1_800 + Math.floor(Math.random() * 3_200);
}

function ticksForElapsed(tickTimesMs: readonly number[], elapsedMs: number): number {
  let low = 0;
  let high = tickTimesMs.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((tickTimesMs[mid] ?? 0) <= elapsedMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function completedDisplayTicks(ticks: number, width: number, phaseElapsedMs: number): number {
  const fullBarTicks = width * BRAILLE_LEVELS.length;
  if (ticks >= fullBarTicks) return fullBarTicks;
  const fillProgress = Math.max(0, Math.min(1, phaseElapsedMs / COMPLETE_FILL_MS));
  return Math.min(fullBarTicks, Math.ceil(ticks + (fullBarTicks - ticks) * fillProgress));
}

function spawningBrailleBar(
  width: number,
  frame: number,
  taskIndex: number,
  colors: ColorPalette,
): string {
  if (width <= 1) {
    return chalk.hex(colors.textMuted)(BRAILLE_SPAWNING_RIGHT);
  }
  let out = '';
  const maxPosition = width - 1;
  const period = maxPosition * 2;
  const position = (frame + taskIndex) % period;
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
