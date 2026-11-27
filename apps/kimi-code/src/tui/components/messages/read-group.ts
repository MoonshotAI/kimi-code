import type { Component, TUI, TuiRenderLine } from '@moonshot-ai/pi-tui';
import { Container, renderComponentLines, Spacer, visibleWidth } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

import { LeadingDecorationText } from './leading-decoration-text';
import type { ToolCallComponent, ToolCallReadSnapshot } from './tool-call';
import { splitToolTranscriptRow } from './tool-renderers/transcript-row';
import type { TranscriptRowParts } from './transcript-row-layout';
import { TruncatedHeaderLine, type HeaderContent } from './truncated-header-line';

const THROTTLE_MS = 200;
const dimHeaderStyle = (text: string): string => currentTheme.dim(text);

interface ReadEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
}

export class ReadGroupComponent extends Container {
  private readonly entries: ReadEntry[] = [];
  private readonly headerText: TruncatedHeaderLine;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushPhases = new Map<string, ToolCallReadSnapshot['phase']>();
  private _invalidating = false;
  private expanded = false;
  private projectionVersion = 0;

  constructor(private readonly ui: TUI | undefined) {
    super();
    this.addChild(new Spacer(1));
    this.headerText = new TruncatedHeaderLine('', visibleWidth(STATUS_BULLET));
    this.addChild(this.headerText);
    this.bodyContainer = new Container();
    this.addChild(this.bodyContainer);
  }

  size(): number {
    return this.entries.length;
  }

  getToolComponents(): readonly ToolCallComponent[] {
    return this.entries.map((entry) => entry.tc);
  }

  get transcriptProjectionVersion(): number {
    return this.projectionVersion + this.entries.reduce(
      (version, entry) => version + entry.tc.transcriptProjectionVersion,
      0,
    );
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.flushRender();
  }

  hasHiddenContent(): boolean {
    return this.entries.length > 0;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  attach(toolCallId: string, tc: ToolCallComponent): void {
    if (this.entries.some((e) => e.toolCallId === toolCallId)) return;
    this.entries.push({ toolCallId, tc });
    this.projectionVersion += 1;
    tc.setSnapshotListener(() => {
      this.scheduleRender();
    });
    this.flushRender();
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    const source: TuiRenderLine[] = [];
    const gutterWidths: number[] = [];
    const append = (component: Component, gutterWidth: number): void => {
      const lines = renderComponentLines(component, width);
      lines.forEach((line, index) => {
        source.push(line);
        gutterWidths.push(index === 0 ? gutterWidth : 0);
      });
    };
    const spacer = this.children[0];
    if (spacer !== undefined) append(spacer, 0);
    append(this.headerText, visibleWidth(STATUS_BULLET));
    for (const child of this.bodyContainer.children) append(child, 5);
    return splitToolTranscriptRow(this, source, width, gutterWidths);
  }

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
    if (this.expanded) {
      const visibleSnapshots = snapshots.filter(
        (snap) => snap.filePath !== undefined && snap.filePath.length > 0,
      );
      visibleSnapshots.forEach((snap, idx) => {
        const isLast = idx === visibleSnapshots.length - 1;
        this.bodyContainer.addChild(new LeadingDecorationText(this.buildBodyLine(snap, isLast), 0, 0));
      });
    }

    this.lastFlushPhases.clear();
    this.entries.forEach((entry, i) => {
      const snap = snapshots[i];
      if (snap !== undefined) this.lastFlushPhases.set(entry.toolCallId, snap.phase);
    });

    this.invalidate();
    this.ui?.requestRender();
  }

  private buildHeader(
    total: number,
    pending: number,
    failed: number,
    totalLines: number,
  ): HeaderContent {
    if (pending > 0) {
      const bullet = currentTheme.fg('text', STATUS_BULLET);
      const label = currentTheme.boldFg('primary', `Reading ${String(total)} files…`);
      return `${bullet}${label}`;
    }

    if (failed === total) {
      const bullet = currentTheme.fg('error', '✗ ');
      const label = currentTheme.boldFg('error', `Read ${String(total)} files`);
      return `${bullet}${label}${currentTheme.fg('error', ' · failed')}`;
    }

    const bullet = currentTheme.fg('success', STATUS_BULLET);
    const label = currentTheme.boldFg('primary', `Read ${String(total)} files`);
    return {
      head: `${bullet}${label}`,
      flex: {
        text: ` · ${String(totalLines)} ${totalLines === 1 ? 'line' : 'lines'}`,
        style: dimHeaderStyle,
        keep: 'head',
      },
      tail: failed > 0 ? currentTheme.fg('error', ` · ${String(failed)} failed`) : '',
    };
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
