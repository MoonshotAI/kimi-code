import type { TUI } from '@moonshot-ai/pi-tui';
import { Container, Spacer, Text } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

import type { ToolCallComponent, ToolCallReadSnapshot } from './tool-call';
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
    this.headerText = new TruncatedHeaderLine('');
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
    let textFiles = 0;
    let totalLines = 0;
    let images = 0;
    let videos = 0;
    for (const snap of snapshots) {
      if (snap.phase === 'pending') pending += 1;
      else if (snap.phase === 'failed') failed += 1;
      else if (snap.mediaKind === 'image') images += 1;
      else if (snap.mediaKind === 'video') videos += 1;
      else {
        textFiles += 1;
        totalLines += snap.lines;
      }
    }
    this.headerText.setText(
      this.buildHeader(snapshots.length, pending, failed, textFiles, totalLines, images, videos),
    );

    this.bodyContainer.clear();
    if (this.expanded) {
      const visibleSnapshots = snapshots.filter(
        (snap) => snap.filePath !== undefined && snap.filePath.length > 0,
      );
      visibleSnapshots.forEach((snap, idx) => {
        const isLast = idx === visibleSnapshots.length - 1;
        this.bodyContainer.addChild(new Text(this.buildBodyLine(snap, isLast), 0, 0));
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
    textFiles: number,
    totalLines: number,
    images: number,
    videos: number,
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
    const summaryParts: string[] = [];
    if (textFiles > 0) {
      summaryParts.push(`${String(totalLines)} ${totalLines === 1 ? 'line' : 'lines'}`);
    }
    if (images > 0) {
      summaryParts.push(`${String(images)} ${images === 1 ? 'image' : 'images'}`);
    }
    if (videos > 0) {
      summaryParts.push(`${String(videos)} ${videos === 1 ? 'video' : 'videos'}`);
    }
    const tail = failed > 0 ? currentTheme.fg('error', ` · ${String(failed)} failed`) : '';
    if (summaryParts.length === 0) {
      return `${bullet}${label}${tail}`;
    }
    return {
      head: `${bullet}${label}`,
      flex: {
        text: ` · ${summaryParts.join(', ')}`,
        style: dimHeaderStyle,
        keep: 'head',
      },
      tail,
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
    } else if (snap.mediaChip !== undefined) {
      tail = dim(` · ${snap.mediaChip}`);
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
