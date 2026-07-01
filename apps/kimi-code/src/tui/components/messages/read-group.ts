/**
 * ReadGroupComponent renders 2+ Read tool calls from the same step as one group.
 *
 * It follows the same structure as `AgentGroupComponent`, with a smaller
 * surface:
 * - one summary header and a tree body listing each file path and status;
 * - permanently grouped, while the body remains visible;
 * - 200ms throttling, matching AgentGroup;
 * - state stays in each `ToolCallComponent`; the group only reads snapshots.
 *
 * Header forms:
 *   pending > 0: Reading {N} files
 *   all done:    Read {N} files · {L} lines
 *   some failed: append · {F} failed
 *   all failed:  Read {N} files · failed
 *
 * Body lines follow AgentGroup's branch style:
 *   src/main.ts · 51 lines
 *   src/cli.ts · reading
 *   src/missing.ts · failed
 */

import type { TUI } from '@moonshot-ai/pi-tui';
import { Container, Spacer, Text } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

import type { ToolCallComponent, ToolCallReadSnapshot } from './tool-call';

const THROTTLE_MS = 200;

interface ReadEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
}

export class ReadGroupComponent extends Container {
  private readonly entries: ReadEntry[] = [];
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushPhases = new Map<string, ToolCallReadSnapshot['phase']>();
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
   * The pending -> done/failed transition is the important visible change, so
   * it refreshes immediately. Other changes are throttled.
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

  private detectPhaseTransition(): boolean {
    for (const e of this.entries) {
      const phase = e.tc.getReadSnapshot().phase;
      if (this.lastFlushPhases.get(e.toolCallId) !== phase) return true;
    }
    return false;
  }

  private flushRender(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    const snapshots = this.entries.map((e) => e.tc.getReadSnapshot());
    let pending = 0;
    let failed = 0;
    let totalLines = 0;
    for (const snap of snapshots) {
      if (snap.phase === 'pending') pending += 1;
      else if (snap.phase === 'failed') failed += 1;
      else totalLines += snap.lines;
    }
    this.headerText.setText(this.buildHeader(snapshots.length, pending, failed, totalLines));

    this.bodyContainer.clear();
    const visibleSnapshots = snapshots.filter(
      (snap) => snap.filePath !== undefined && snap.filePath.length > 0,
    );
    visibleSnapshots.forEach((snap, idx) => {
      const isLast = idx === visibleSnapshots.length - 1;
      this.bodyContainer.addChild(new Text(this.buildBodyLine(snap, isLast), 0, 0));
    });

    this.lastFlushPhases.clear();
    this.entries.forEach((entry, i) => {
      const snap = snapshots[i];
      if (snap !== undefined) this.lastFlushPhases.set(entry.toolCallId, snap.phase);
    });

    this.invalidate();
    this.ui?.requestRender();
  }

  private buildHeader(total: number, pending: number, failed: number, totalLines: number): string {
    const dim = (text: string): string => currentTheme.dim(text);

    if (pending > 0) {
      const bullet = currentTheme.fg('text', STATUS_BULLET);
      const label = currentTheme.boldFg('primary', `Reading ${String(total)} files…`);
      return `${bullet}${label}`;
    }

    // All reads have finished, either successfully or with failures.
    if (failed === total) {
      const bullet = currentTheme.fg('error', '✗ ');
      const label = currentTheme.boldFg('error', `Read ${String(total)} files`);
      return `${bullet}${label}${currentTheme.fg('error', ' · failed')}`;
    }

    const bullet = currentTheme.fg('success', STATUS_BULLET);
    const label = currentTheme.boldFg('primary', `Read ${String(total)} files`);
    const linesPart = dim(` · ${String(totalLines)} ${totalLines === 1 ? 'line' : 'lines'}`);
    const failPart = failed > 0 ? currentTheme.fg('error', ` · ${String(failed)} failed`) : '';
    return `${bullet}${label}${linesPart}${failPart}`;
  }

  private buildBodyLine(snap: ToolCallReadSnapshot, isLast: boolean): string {
    const dim = (text: string): string => currentTheme.dim(text);
    const branch = isLast ? '└─' : '├─';
    const path = snap.filePath ?? '';
    const pathPart = currentTheme.fg('text', path);

    let tail: string;
    if (snap.phase === 'pending') {
      tail = dim(' · reading…');
    } else if (snap.phase === 'failed') {
      tail = currentTheme.fg('error', ' · failed');
    } else {
      tail = dim(` · ${String(snap.lines)} ${snap.lines === 1 ? 'line' : 'lines'}`);
    }
    return `  ${branch} ${pathPart}${tail}`;
  }

  override invalidate(): void {
    if (this._invalidating) {
      super.invalidate();
      return;
    }
    this._invalidating = true;
    this.flushRender();
    this._invalidating = false;
  }

  /** Releases throttle timers so destroyed components cannot refresh later. */
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
