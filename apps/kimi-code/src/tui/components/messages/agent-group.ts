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

import type { TUI } from '@earendil-works/pi-tui';
import { Container, Spacer, Text } from '@earendil-works/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

import type { ToolCallComponent, ToolCallSubagentSnapshot } from './tool-call';

const THROTTLE_MS = 200;

interface AgentEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
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
    const done = snapshots.filter((s) => s.phase === 'done').length;
    const failed = snapshots.filter((s) => s.phase === 'failed').length;
    const finished = done + failed;
    const allDone = finished === total;
    const bullet = allDone
      ? currentTheme.fg('success', STATUS_BULLET)
      : currentTheme.fg('roleAssistant', STATUS_BULLET);

    if (allDone) {
      const types = new Set(snapshots.map((s) => s.agentName).filter((n) => n !== undefined));
      const headerLabel =
        types.size === 1
          ? `${String(total)} ${[...types][0]} agents finished`
          : `${String(total)} agents finished`;
      const totalTools = snapshots.reduce((acc, s) => acc + s.toolCount, 0);
      const totalTokens = snapshots.reduce((acc, s) => acc + s.tokens, 0);
      const tail = formatHeaderTail(totalTools, totalTokens);
      return `${bullet}${currentTheme.boldFg('primary', headerLabel)}${tail}`;
    }

    let headerText = `Running ${String(total)} agents`;
    // Mixed status gets a breakdown so the current state is clear.
    if (finished > 0) {
      const running = total - finished;
      const parts: string[] = [];
      if (done > 0) parts.push(`${String(done)} done`);
      if (failed > 0) parts.push(`${String(failed)} failed`);
      if (running > 0) parts.push(`${String(running)} running`);
      headerText = `Running ${String(total)} agents (${parts.join(', ')})`;
    }
    return `${bullet}${currentTheme.boldFg('primary', headerText)}`;
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
    const activity = snap.latestActivity ?? 'Initializing…';
    this.bodyContainer.addChild(new Text(`  ${branch2}    ${dim(activity)}`, 0, 0));
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

function formatStats(snap: ToolCallSubagentSnapshot): string {
  const dim = (text: string) => currentTheme.dim(text);
  const tools = ` · ${String(snap.toolCount)} tool${snap.toolCount === 1 ? '' : 's'}`;
  const tokens = snap.tokens > 0 ? ` · ${formatTokens(snap.tokens)}` : '';
  return dim(`${tools}${tokens}`);
}

function formatLineTail(snap: ToolCallSubagentSnapshot): string {
  const dim = (text: string) => currentTheme.dim(text);
  if (snap.phase === 'done') {
    return dim(' · ') + currentTheme.fg('success', '✓ Completed');
  }
  if (snap.phase === 'failed') {
    return dim(' · ') + currentTheme.fg('error', '✗ Failed');
  }
  if (snap.phase === 'backgrounded') {
    return dim(' · ◐ backgrounded');
  }
  return '';
}

function formatHeaderTail(toolCount: number, tokens: number): string {
  const dim = (text: string) => currentTheme.dim(text);
  const parts: string[] = [];
  if (toolCount > 0) parts.push(`${String(toolCount)} tool${toolCount === 1 ? '' : 's'}`);
  if (tokens > 0) parts.push(formatTokens(tokens));
  return parts.length > 0 ? dim(` · ${parts.join(' · ')}`) : '';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${String(n)} tok`;
}
