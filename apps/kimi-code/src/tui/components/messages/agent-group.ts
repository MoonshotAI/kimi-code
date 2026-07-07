/**
 * AgentGroupComponent renders 2+ Agent tool calls from the same step as one group.
 *
 * Design:
 * - State container: each child Agent keeps its real state in its
 *   `ToolCallComponent` (subagent meta, phase, sub-tool calls, tokens, text).
 *   AgentGroup only stores references and does not copy state. Event handlers
 *   still route through `state.pendingToolComponents.get(parent_tool_call_id)`.
 * - Subscription: `attach` registers a snapshot listener on each child so the
 *   group can refresh when child state changes.
 * - Throttling: normal changes are coalesced into one render every 200ms.
 *   Phase transitions (spawning -> running -> done/failed) flush immediately.
 * - Mounting: `KimiTUI` attaches the group to the transcript at the
 *   right time; the group handles `invalidate` plus `ui.requestRender`.
 * - Ungrouping is not implemented. Once formed, a group stays grouped.
 */

import type { TUI } from '@moonshot-ai/pi-tui';
import { Container, Spacer, Text } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

import type { ToolCallComponent, ToolCallSubagentSnapshot } from './tool-call';

const THROTTLE_MS = 200;

const DETACH_HINT_TEXT = 'Press Ctrl+B to run in background';

interface AgentEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
}

interface PhaseCounts {
  readonly done: number;
  readonly failed: number;
  readonly backgrounded: number;
  readonly running: number;
  readonly waiting: number;
  readonly starting: number;
  readonly terminal: number;
}

export class AgentGroupComponent extends Container {
  private readonly entries: AgentEntry[] = [];
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushPhases = new Map<string, ToolCallSubagentSnapshot['phase']>();
  private _invalidating = false;

  constructor(private readonly ui: TUI | undefined) {
    super();
    this.addChild(new Spacer(1));
    this.headerText = new Text('', 0, 0);
    this.addChild(this.headerText);
    this.bodyContainer = new Container();
    this.addChild(this.bodyContainer);
  }

  size(): number {
    return this.entries.length;
  }

  /**
   * Exposes the borrowed tool call components so external code (e.g.
   * routing background task terminal events back to the corresponding
   * Agent card) can reach them — the group renders the tcs' snapshots
   * but never mounts the tcs as Container children, so a plain tree
   * walk of `transcriptContainer` cannot discover them.
   */
  getToolComponents(): readonly ToolCallComponent[] {
    return this.entries.map((entry) => entry.tc);
  }

  /**
   * Borrows a standalone `ToolCallComponent` into the group as a hidden state
   * container. Snapshot changes trigger throttled refreshes. Re-attaching the
   * same toolCallId is a no-op.
   */
  attach(toolCallId: string, tc: ToolCallComponent): void {
    if (this.entries.some((e) => e.toolCallId === toolCallId)) return;
    this.entries.push({ toolCallId, tc });
    tc.setSnapshotListener(() => {
      this.scheduleRender();
    });
    this.flushRender();
  }

  /**
   * Schedules a repaint. Real phase transitions force an immediate refresh;
   * other changes such as latestActivity, tokens, or toolCount are throttled.
   */
  private scheduleRender(): void {
    if (this.detectPhaseTransition()) {
      this.flushRender();
      return;
    }
    if (this.throttleTimer !== null) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.flushRender();
    }, THROTTLE_MS);
  }

  /**
   * Compares each child's current phase with the phase captured at the last
   * flush. Any change is treated as a phase transition.
   */
  private detectPhaseTransition(): boolean {
    let changed = false;
    for (const e of this.entries) {
      const phase = e.tc.getSubagentSnapshot().phase;
      if (this.lastFlushPhases.get(e.toolCallId) !== phase) {
        changed = true;
        break;
      }
    }
    return changed;
  }

  private flushRender(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    const snapshots = this.entries.map((e) => e.tc.getSubagentSnapshot());
    this.headerText.setText(this.buildHeader(snapshots));
    this.bodyContainer.clear();
    snapshots.forEach((snap, idx) => {
      const isLast = idx === snapshots.length - 1;
      this.appendLines(snap, isLast);
    });
    if (this.shouldShowDetachHint(snapshots)) {
      this.bodyContainer.addChild(new Text(currentTheme.dim(DETACH_HINT_TEXT), 2, 0));
    }

    this.lastFlushPhases.clear();
    this.entries.forEach((entry, i) => {
      const snap = snapshots[i];
      if (snap !== undefined) this.lastFlushPhases.set(entry.toolCallId, snap.phase);
    });

    this.invalidate();
    this.ui?.requestRender();
  }

  private buildHeader(snapshots: readonly ToolCallSubagentSnapshot[]): string {
    const total = snapshots.length;
    const counts = countPhases(snapshots);
    const allDone = counts.terminal === total;
    const bullet = allDone
      ? currentTheme.fg('success', STATUS_BULLET)
      : currentTheme.fg('text', STATUS_BULLET);
    const elapsedSeconds = maxElapsedSeconds(snapshots);

    if (allDone) {
      const types = new Set(snapshots.map((s) => s.agentName).filter((n) => n !== undefined));
      const headerLabel =
        types.size === 1
          ? `${String(total)} ${[...types][0]} agents finished`
          : `${String(total)} agents finished`;
      const totalTools = snapshots.reduce((acc, s) => acc + s.toolCount, 0);
      const totalTokens = snapshots.reduce((acc, s) => acc + s.tokens, 0);
      const tail = formatHeaderTail({ toolCount: totalTools, tokens: totalTokens, elapsedSeconds });
      return `${bullet}${currentTheme.boldFg('primary', headerLabel)}${tail}`;
    }

    const parts = formatBreakdownParts(counts);
    const headerText = parts.length > 0
      ? `Running ${String(total)} agents (${parts.join(', ')})`
      : `Running ${String(total)} agents`;
    const tail = formatHeaderTail({ toolCount: 0, tokens: 0, elapsedSeconds });
    return `${bullet}${currentTheme.boldFg('primary', headerText)}${tail}`;
  }

  private appendLines(snap: ToolCallSubagentSnapshot, isLast: boolean): void {
    const dim = (text: string) => currentTheme.dim(text);

    // First-level branch line.
    const branch1 = isLast ? '└─' : '├─';
    const agentType = snap.agentName ?? 'agent';
    const desc = snap.toolCallDescription || '(no description)';
    const tail = formatLineTail(snap);
    const namePart = currentTheme.fg('primary', agentType);
    const descPart = dim(`· ${desc}`);
    const stats = formatStats(snap);
    const line1 = `  ${branch1} ${namePart} ${descPart}${stats}${tail}`;
    this.bodyContainer.addChild(new Text(line1, 0, 0));

    // Second-level line: latest activity, or Error for failures.
    const branch2 = isLast ? '   ' : '│  ';
    if (snap.phase === 'failed') {
      // Show one error line; error messages can be long.
      const errLine = (snap.errorText ?? 'Failed').split('\n').at(0) ?? 'Failed';
      const errStr = currentTheme.fg('error', `Error: ${errLine}`);
      this.bodyContainer.addChild(new Text(`  ${branch2}    ${errStr}`, 0, 0));
      return;
    }
    if (snap.phase === 'done' || snap.phase === 'backgrounded') {
      // Terminal states omit the second line.
      return;
    }
    // Running or not-yet-started agents show latest activity, with a fallback.
    const activity = snap.latestActivity ?? fallbackActivityForPhase(snap.phase);
    this.bodyContainer.addChild(new Text(`  ${branch2}    ${dim(activity)}`, 0, 0));
  }

  /**
   * Show the Ctrl+B hint while at least one agent in the group is still
   * running in the foreground (i.e. can be detached). Hide it once every
   * agent is done, failed, or already backgrounded.
   */
  private shouldShowDetachHint(snapshots: readonly ToolCallSubagentSnapshot[]): boolean {
    return snapshots.some(
      (s) =>
        s.phase === 'running' ||
        s.phase === 'queued' ||
        s.phase === 'spawning' ||
        s.phase === undefined,
    );
  }

  /** Releases throttle timers so destroyed components cannot refresh later. */
  override invalidate(): void {
    if (this._invalidating) {
      super.invalidate();
      return;
    }
    this._invalidating = true;
    this.flushRender();
    this._invalidating = false;
  }

  dispose(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    for (const e of this.entries) {
      e.tc.setSnapshotListener(undefined);
    }
  }
}

function countPhases(snapshots: readonly ToolCallSubagentSnapshot[]): PhaseCounts {
  let done = 0;
  let failed = 0;
  let backgrounded = 0;
  let running = 0;
  let waiting = 0;
  let starting = 0;

  for (const snap of snapshots) {
    switch (snap.phase) {
      case 'done':
        done += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'backgrounded':
        backgrounded += 1;
        break;
      case 'queued':
        waiting += 1;
        break;
      case 'running':
        running += 1;
        break;
      case 'spawning':
      case undefined:
        starting += 1;
        break;
    }
  }

  return {
    done,
    failed,
    backgrounded,
    running,
    waiting,
    starting,
    terminal: done + failed + backgrounded,
  };
}

function formatBreakdownParts(counts: PhaseCounts): string[] {
  const parts: string[] = [];
  if (counts.done > 0) parts.push(`${String(counts.done)} done`);
  if (counts.failed > 0) parts.push(`${String(counts.failed)} failed`);
  if (counts.backgrounded > 0) parts.push(`${String(counts.backgrounded)} backgrounded`);
  if (counts.running > 0) parts.push(`${String(counts.running)} running`);
  if (counts.waiting > 0) parts.push(`${String(counts.waiting)} waiting`);
  if (counts.starting > 0) parts.push(`${String(counts.starting)} starting`);
  return parts;
}

function formatStats(snap: ToolCallSubagentSnapshot): string {
  const parts = [`${String(snap.toolCount)} tool${snap.toolCount === 1 ? '' : 's'}`];
  if (snap.elapsedSeconds !== undefined) parts.push(formatElapsed(snap.elapsedSeconds));
  if (snap.tokens > 0) parts.push(formatTokens(snap.tokens));
  return currentTheme.dim(` · ${parts.join(' · ')}`);
}

function formatLineTail(snap: ToolCallSubagentSnapshot): string {
  const separator = currentTheme.dim(' · ');
  switch (snap.phase) {
    case 'done':
      return separator + currentTheme.fg('success', '✓ Completed');
    case 'failed':
      return separator + currentTheme.fg('error', '✗ Failed');
    case 'backgrounded':
      return separator + currentTheme.dim('◐ backgrounded');
    case 'queued':
      return separator + currentTheme.fg('primary', 'Waiting');
    case 'running':
      return separator + currentTheme.fg('primary', 'Running');
    case 'spawning':
    case undefined:
      return separator + currentTheme.fg('primary', 'Starting');
  }
}

function fallbackActivityForPhase(phase: ToolCallSubagentSnapshot['phase']): string {
  switch (phase) {
    case 'queued':
      return 'Waiting to start…';
    case 'running':
      return 'Still working…';
    case 'spawning':
    case undefined:
      return 'Starting…';
    case 'done':
    case 'failed':
    case 'backgrounded':
      return '';
  }
}

function formatHeaderTail(args: {
  readonly toolCount: number;
  readonly tokens: number;
  readonly elapsedSeconds: number | undefined;
}): string {
  const parts: string[] = [];
  if (args.toolCount > 0) parts.push(`${String(args.toolCount)} tool${args.toolCount === 1 ? '' : 's'}`);
  if (args.tokens > 0) parts.push(formatTokens(args.tokens));
  if (args.elapsedSeconds !== undefined) parts.push(formatElapsed(args.elapsedSeconds));
  return parts.length > 0 ? currentTheme.dim(` · ${parts.join(' · ')}`) : '';
}

function maxElapsedSeconds(snapshots: readonly ToolCallSubagentSnapshot[]): number | undefined {
  let max: number | undefined;
  for (const snap of snapshots) {
    const elapsed = snap.elapsedSeconds;
    if (elapsed === undefined) continue;
    max = max === undefined ? elapsed : Math.max(max, elapsed);
  }
  return max;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${String(n)} tok`;
}
