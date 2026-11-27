import {
  decorateRenderLine,
  prefixRenderLine,
  RENDER_LINES,
  renderComponentLines,
  renderLineTexts,
  Text,
  textRenderLine,
  visibleWidth,
  withRenderLineText,
  type Component,
  type TuiRenderLine,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import { mixColors } from '#/tui/theme/color-mix';
import { hasRowDetail, hasStatusMarker, isExpandedComponent } from '#/tui/utils/component-capabilities';
import {
  deriveGroupView,
  elapsedText,
  oneLine,
  rowStatusOf,
  tailText,
  titleText,
  type GroupView,
  type GroupViewInput,
  type RowStatus,
} from '#/tui/utils/group-view';
import type { LogicalTranscriptItem } from '#/tui/utils/transcript-items';
import {
  instant,
  monotonicNow,
  settledAt,
  shownThinkingAt,
  type Instant,
  type ShownThinking,
  type TimelineReader,
} from '#/tui/utils/turn-timeline';
import { TitleSweep } from './running-title';
import type { TranscriptRowParts } from './transcript-row-layout';
import { renderHeaderContent, TruncatedHeaderLine } from './truncated-header-line';

export interface TranscriptGroupModel extends GroupViewInput {
  readonly anchor: Component;
  readonly sourceIndex: number;
  readonly expanded: boolean;
}

export interface TranscriptGroupInteraction {
  toggleGroup(anchor: Component, fromBottom?: { readonly removedLines: number }): void;
  toggleRow(item: LogicalTranscriptItem): boolean;
  viewportRows(): number | undefined;
  requestRender(): void;
  requestAnimationFrame(callback: (time: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

type GroupBody =
  | { readonly kind: 'none' }
  | { readonly kind: 'rows' }
  | { readonly kind: 'detail'; readonly item: LogicalTranscriptItem; readonly withRow: boolean };

type HitAction =
  | { readonly kind: 'toggleGroup' }
  | { readonly kind: 'showLess'; readonly removedLines: number }
  | { readonly kind: 'toggleRow'; readonly item: LogicalTranscriptItem };

interface HitRegion {
  readonly start: number;
  readonly end: number;
  readonly action: HitAction;
}

type Branch = 'middle' | 'last' | 'indent' | 'bare';

type RowForm = 'line' | 'wrapped' | 'none';

interface RowLines {
  readonly lines: readonly TuiRenderLine[];
  readonly gutterLines: readonly TuiRenderLine[];
  readonly contentLines: readonly TuiRenderLine[];
  readonly gutterWidths: readonly number[];
}

interface RowDetail {
  readonly lines: readonly TuiRenderLine[];
  readonly gutterWidth: number;
}

interface MemberDraft {
  readonly item: LogicalTranscriptItem;
  readonly rowKey: string;
  readonly row: RowLines;
  readonly detail: RowDetail | undefined;
}

interface MemberFrame extends MemberDraft {
  readonly branch: Branch;
  readonly lines: readonly TuiRenderLine[];
  readonly gutterLines: readonly TuiRenderLine[];
  readonly contentLines: readonly TuiRenderLine[];
  readonly gutterWidths: readonly number[];
}

interface TitleFrame extends TranscriptRowParts {
  readonly lines: readonly TuiRenderLine[];
}

interface FrameKey {
  readonly model: TranscriptGroupModel;
  readonly width: number;
  readonly palette: ColorPalette;
  readonly background: string;
  readonly viewportRows: number | undefined;
  readonly title: string;
  readonly sweep: string;
  readonly rows: string;
  readonly tail: string | undefined;
}

interface Frame {
  readonly key: FrameKey;
  readonly separated: boolean;
  readonly title: TitleFrame;
  readonly members: readonly MemberFrame[];
  readonly lines: TuiRenderLine[];
  readonly parts: TranscriptRowParts;
  readonly regions: readonly HitRegion[];
}

const MARKER = '●';
const TITLE_INDENT = '  ';
const TAIL_HEAD = `${TITLE_INDENT}└ `;
const MIN_WRAPPED_SUBJECT_WIDTH = 8;

export class TranscriptGroupComponent implements Component {
  private model: TranscriptGroupModel;
  private readonly header = new TruncatedHeaderLine('');
  private frame: Frame | undefined;
  private frameRequest: number | undefined;
  private disposed = false;
  private readonly sweep = new TitleSweep();
  private shownThinking: ShownThinking | undefined;

  constructor(
    model: TranscriptGroupModel,
    private readonly interaction: TranscriptGroupInteraction,
  ) {
    this.model = model;
    this.syncFrames();
  }

  setModel(model: TranscriptGroupModel): void {
    this.model = model;
    this.syncFrames();
  }

  invalidate(): void {
    this.header.invalidate();
    this.frame = undefined;
    for (const member of this.model.members) member.display.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.stopFrames();
    this.frame = undefined;
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    return this.renderFrame(width, true).parts;
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    return this.renderFrame(width, false).lines;
  }

  private renderFrame(width: number, separated: boolean): Frame {
    const now = monotonicNow();
    const { view, thinking } = this.paceTail(deriveGroupView(this.model, now), now);
    this.shownThinking = thinking;
    if (view.live && this.frameRequest === undefined) this.syncFrames();
    const key = this.frameKey(view, width, now);
    const previous = this.frame;
    const sameKey = previous !== undefined && previous.separated === separated && sameFrameKey(previous.key, key);
    const title = sameKey ? previous.title : this.renderTitle(view, width, now);
    const sameBase = previous !== undefined &&
      previous.separated === separated &&
      previous.key.width === width &&
      previous.key.palette === key.palette &&
      previous.key.background === key.background;
    const { members, showLess } = this.renderMembers(
      view,
      width,
      now,
      title.lines.length + 2,
      key.viewportRows,
      sameBase ? previous.members : [],
      separated,
    );
    if (
      sameKey &&
      members.length === previous.members.length &&
      members.every((member, index) => member.lines === previous.members[index]?.lines)
    ) {
      return previous;
    }

    const lines = [blankRenderLine(TITLE_INDENT), ...title.lines];
    const gutterLines: TuiRenderLine[] = [textRenderLine(''), ...title.gutterLines];
    const contentLines: TuiRenderLine[] = [textRenderLine(''), ...title.contentLines];
    const gutterWidths: number[] = [TITLE_INDENT.length, ...title.contentLines.map(() => TITLE_INDENT.length)];
    const regions: HitRegion[] = [{ start: 1, end: lines.length, action: { kind: 'toggleGroup' } }];
    if (this.model.expanded) {
      lines.push(blankRenderLine(TITLE_INDENT));
      gutterLines.push(textRenderLine(''));
      contentLines.push(textRenderLine(''));
      gutterWidths.push(TITLE_INDENT.length);
      const rows = bodyOf(this.model, view).kind === 'rows';
      for (const member of members) {
        const start = lines.length;
        lines.push(...member.lines);
        gutterLines.push(...member.gutterLines);
        contentLines.push(...member.contentLines);
        gutterWidths.push(...member.gutterWidths);
        regions.push({
          start,
          end: lines.length,
          action: rows ? { kind: 'toggleRow', item: member.item } : { kind: 'toggleGroup' },
        });
      }
      if (showLess) {
        const start = lines.length;
        const guide = chalk.hex(this.guideColor())('└ ');
        const label = currentTheme.fg('textDim', 'Show less');
        lines.push(textRenderLine(`${guide}${label}`));
        gutterLines.push(textRenderLine(guide));
        contentLines.push(textRenderLine(label));
        gutterWidths.push(visibleWidth(guide));
        regions.push({ start, end: lines.length, action: { kind: 'showLess', removedLines: lines.length - 2 } });
      }
    }
    if (key.tail !== undefined) {
      if (!this.model.expanded && key.tail.length > 0) {
        regions.push({ start: lines.length, end: lines.length + 1, action: { kind: 'toggleGroup' } });
      }
      const empty = key.tail.length === 0;
      const tail = empty ? { gutter: '', content: '' } : splitDimmedTail(key.tail);
      const gutter = empty ? '' : `${TITLE_INDENT}${tail.gutter}`;
      lines.push(empty
        ? blankRenderLine(TITLE_INDENT)
        : decorateRenderLine(textRenderLine(currentTheme.dim(`└ ${key.tail}`)), TITLE_INDENT));
      gutterLines.push(textRenderLine(gutter));
      contentLines.push(textRenderLine(tail.content));
      gutterWidths.push(empty ? TITLE_INDENT.length : visibleWidth(gutter));
    }
    const parts = { gutterWidth: TITLE_INDENT.length, gutterWidths, gutterLines, contentLines };
    this.frame = { key, separated, title, members, lines, parts, regions };
    return this.frame;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    const region = this.frame?.regions.find((candidate) => event.y >= candidate.start && event.y < candidate.end);
    if (region === undefined) return undefined;
    const action = region.action;
    switch (action.kind) {
      case 'toggleGroup':
        this.interaction.toggleGroup(this.model.anchor);
        return { handled: true };
      case 'showLess':
        this.interaction.toggleGroup(this.model.anchor, { removedLines: action.removedLines });
        return { handled: true };
      case 'toggleRow':
        return this.interaction.toggleRow(action.item) ? { handled: true } : undefined;
    }
  }

  private frameKey(view: GroupView, width: number, now: Instant): FrameKey {
    const { timeline, expanded } = this.model;
    return {
      model: this.model,
      width,
      palette: currentTheme.palette,
      background: currentTheme.terminalBackground(),
      viewportRows: this.interaction.viewportRows(),
      title: `${titleText(view.title)}\n${titleSuffix(view, now)}`,
      sweep: this.sweep.frameKey,
      rows: expanded
        ? this.model.members.map((item) => statusKey(rowStatusOf(item, timeline, now), now)).join('\n')
        : '',
      tail: view.tail === undefined ? undefined : tailText(view.tail, width - visibleWidth(TAIL_HEAD), now),
    };
  }

  private renderTitle(view: GroupView, width: number, now: Instant): TitleFrame {
    const paint = this.sweep.painter();
    const style = (text: string): string => paint(text, TITLE_INDENT.length);
    const head = this.model.expanded ? `${paint(MARKER, 0)} ` : TITLE_INDENT;
    const suffix = titleSuffix(view, now);
    if (view.title.kind === 'item' && this.model.expanded) {
      const { verb, subject } = view.title.item.label;
      const full = subject === undefined ? verb : `${verb} ${subject}`;
      const contentLines = wrapStructuredText(`${style(full)}${suffix}`, Math.max(1, width - TITLE_INDENT.length));
      const gutterLines = contentLines.map((_, index) => textRenderLine(index === 0 ? head : TITLE_INDENT));
      const lines = contentLines.map((line, index) => decorateRenderLine(
        line,
        index === 0 ? head : TITLE_INDENT,
      ));
      return { gutterWidth: TITLE_INDENT.length, gutterLines, contentLines, lines };
    }
    this.header.setText({
      head: '',
      flex: { text: titleText(view.title), style, keep: 'head' },
      tail: suffix,
    });
    const contentLines = renderComponentLines(this.header, Math.max(1, width - visibleWidth(head)));
    return {
      gutterWidth: TITLE_INDENT.length,
      gutterLines: contentLines.map(() => textRenderLine(head)),
      contentLines,
      lines: contentLines.map((line) => decorateRenderLine(line, head)),
    };
  }

  private renderMembers(
    view: GroupView,
    width: number,
    now: Instant,
    headerHeight: number,
    viewportRows: number | undefined,
    previous: readonly MemberFrame[],
    separated: boolean,
  ): { readonly members: readonly MemberFrame[]; readonly showLess: boolean } {
    const body = bodyOf(this.model, view);
    if (body.kind === 'none') return { members: [], showLess: false };
    const { timeline } = this.model;
    const inner = Math.max(1, width - TITLE_INDENT.length);
    const draft = (item: LogicalTranscriptItem, form: RowForm, open: boolean, columns: number, index: number): MemberDraft =>
      memberDraft(item, rowStatusOf(item, timeline, now), form, open, columns, now, previous[index], separated);
    const drafts = body.kind === 'detail'
      ? [draft(body.item, body.withRow ? 'wrapped' : 'none', true, body.withRow ? inner : width, 0)]
      : this.model.members.map((item, index) => {
        const open = isExpandedComponent(item.display);
        return draft(item, open ? 'wrapped' : 'line', open, inner, index);
      });
    const height = headerHeight + drafts.reduce((total, member) => total + member.row.lines.length + (member.detail?.lines.length ?? 0), 0);
    const showLess = viewportRows !== undefined && height > viewportRows;
    const guide = (text: string): string => chalk.hex(this.guideColor())(text);
    const members = drafts.map((member, index): MemberFrame => {
      let branch: Branch = 'bare';
      if (body.kind === 'rows') branch = index === drafts.length - 1 && !showLess ? 'last' : 'middle';
      else if (body.withRow) branch = 'indent';
      const reused = previous[index];
      if (
        reused !== undefined &&
        reused.item.display === member.item.display &&
        reused.row === member.row &&
        reused.detail === member.detail &&
        reused.branch === branch
      ) {
        return { ...reused, item: member.item };
      }
      const prefix = prefixFor(branch, guide);
      const rowCount = member.row.lines.length;
      const sourceLines = [...member.row.lines, ...(member.detail?.lines ?? [])];
      const lines = sourceLines.map((line, lineIndex) => prefixRenderLine(line, prefix(lineIndex === 0)));
      const gutterLines = sourceLines.map((_, lineIndex) => {
        const alignment = lineIndex < rowCount
          ? member.row.gutterLines[lineIndex]?.text ?? ''
          : ' '.repeat(member.detail?.gutterWidth ?? 0);
        return textRenderLine(`${prefix(lineIndex === 0)}${alignment}`);
      });
      const contentLines = [...member.row.contentLines, ...(member.detail?.lines ?? [])];
      const gutterWidths = sourceLines.map((_, lineIndex) => {
        const alignment = lineIndex < rowCount
          ? member.row.gutterWidths[lineIndex] ?? 0
          : member.detail?.gutterWidth ?? 0;
        return visibleWidth(prefix(lineIndex === 0)) + alignment;
      });
      return { ...member, branch, lines, gutterLines, contentLines, gutterWidths };
    });
    return { members, showLess };
  }

  private guideColor(): string {
    return mixColors(
      currentTheme.color('textDim'),
      currentTheme.terminalBackground(),
      currentTheme.isLight() ? 0.65 : 0.60,
    );
  }

  private syncFrames(): void {
    const now = monotonicNow();
    const view = deriveGroupView(this.model, now);
    if (this.disposed || (!view.live && this.sweep.intensity === 0)) {
      this.stopFrames();
      return;
    }
    if (this.frameRequest !== undefined) return;
    this.sweep.start(now, view.working);
    this.frameRequest = this.interaction.requestAnimationFrame(this.onFrame);
  }

  private readonly onFrame = (time: number): void => {
    this.frameRequest = undefined;
    const now = instant(time);
    const { view } = this.paceTail(deriveGroupView(this.model, now), now);
    this.sweep.advance(now, TITLE_INDENT.length + visibleWidth(titleText(view.title)), view.working);
    const frame = this.frame;
    if (frame === undefined || !sameFrameKey(frame.key, this.frameKey(view, frame.key.width, now))) {
      this.interaction.requestRender();
    }
    if (view.live || this.sweep.intensity > 0) this.frameRequest = this.interaction.requestAnimationFrame(this.onFrame);
  };

  private stopFrames(): void {
    if (this.frameRequest === undefined) return;
    this.interaction.cancelAnimationFrame(this.frameRequest);
    this.frameRequest = undefined;
  }

  private paceTail(view: GroupView, now: Instant): { readonly view: GroupView; readonly thinking?: ShownThinking } {
    const { tail } = view;
    if (tail?.kind !== 'thinking' && tail?.kind !== 'thought') return { view };
    const thinking = shownThinkingAt(this.shownThinking, tail.text, now);
    return { view: { ...view, tail: { ...tail, text: thinking.text } }, thinking };
  }
}

export type TranscriptRowInteraction = Pick<
  TranscriptGroupInteraction,
  'toggleRow' | 'requestRender' | 'requestAnimationFrame' | 'cancelAnimationFrame'
>;

interface RowFrame {
  readonly item: LogicalTranscriptItem;
  readonly width: number;
  readonly palette: ColorPalette;
  readonly status: string;
  readonly open: boolean;
  readonly separated: boolean;
  readonly detail: RowDetail | undefined;
  readonly lines: TuiRenderLine[];
  readonly parts: TranscriptRowParts;
}

export class TranscriptRowComponent implements Component {
  private frame: RowFrame | undefined;
  private frameRequest: number | undefined;
  private disposed = false;

  constructor(
    private item: LogicalTranscriptItem,
    private timeline: TimelineReader,
    private readonly interaction: TranscriptRowInteraction,
  ) {
    this.syncFrames();
  }

  setItem(item: LogicalTranscriptItem, timeline: TimelineReader): void {
    this.item = item;
    this.timeline = timeline;
    this.syncFrames();
  }

  invalidate(): void {
    this.frame = undefined;
    this.item.display.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.stopFrames();
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    return this.renderFrame(width, true).parts;
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    return this.renderFrame(width, false).lines;
  }

  private renderFrame(width: number, separated: boolean): RowFrame {
    const now = monotonicNow();
    const status = rowStatusOf(this.item, this.timeline, now);
    const key = statusKey(status, now);
    const { display } = this.item;
    const open = isExpandedComponent(display);
    const shown = open || this.item.detailWhile?.includes(status.kind) === true;
    const detail = shown ? renderRowDetail(display, width, separated) : undefined;
    const previous = this.frame;
    if (
      previous?.item === this.item &&
      previous.width === width &&
      previous.palette === currentTheme.palette &&
      previous.status === key &&
      previous.open === open &&
      previous.separated === separated &&
      previous.detail === detail
    ) {
      return previous;
    }
    const marker = rowMarker(this.item);
    const markerWidth = visibleWidth(marker);
    const indent = ' '.repeat(markerWidth);
    const columns = Math.max(1, width - indent.length);
    const row = open
      ? wrappedRow(this.item, status, columns, now)
      : singleRow(this.item, status, columns, now);
    const detailWidth = detail?.gutterWidth ?? 0;
    const lines = [
      blankRenderLine(indent),
      ...row.lines.map((line, index) => decorateRenderLine(line, index === 0 ? marker : indent)),
      ...(detail?.lines ?? []),
    ];
    const gutterLines = [
      textRenderLine(''),
      ...row.lines.map((_, index) => textRenderLine(
        `${index === 0 ? marker : indent}${row.gutterLines[index]?.text ?? ''}`,
      )),
      ...(detail?.lines ?? []).map(() => textRenderLine(' '.repeat(detailWidth))),
    ];
    const contentLines = [textRenderLine(''), ...row.contentLines, ...(detail?.lines ?? [])];
    const gutterWidths = [
      markerWidth,
      ...row.lines.map((_, index) => markerWidth + (row.gutterWidths[index] ?? 0)),
      ...(detail?.lines ?? []).map(() => detailWidth),
    ];
    const parts = { gutterWidth: markerWidth, gutterWidths, gutterLines, contentLines };
    this.frame = {
      item: this.item,
      width,
      palette: currentTheme.palette,
      status: key,
      open,
      separated,
      detail,
      lines,
      parts,
    };
    return this.frame;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left' || event.y < 1) return undefined;
    const status = rowStatusOf(this.item, this.timeline, monotonicNow());
    if (status.kind === 'running' && this.item.detailWhile?.includes(status.kind) === true) return undefined;
    return this.interaction.toggleRow(this.item) ? { handled: true } : undefined;
  }

  private live(now: Instant): boolean {
    const facts = this.item.callId === undefined ? undefined : this.timeline.call(this.item.callId);
    return !this.disposed && !settledAt(facts, now);
  }

  private syncFrames(): void {
    if (!this.live(monotonicNow())) {
      this.stopFrames();
      return;
    }
    this.frameRequest ??= this.interaction.requestAnimationFrame(this.onFrame);
  }

  private readonly onFrame = (time: number): void => {
    this.frameRequest = undefined;
    const now = instant(time);
    const frame = this.frame;
    if (frame !== undefined && frame.status !== statusKey(rowStatusOf(this.item, this.timeline, now), now)) {
      this.interaction.requestRender();
    }
    if (this.live(now)) this.frameRequest = this.interaction.requestAnimationFrame(this.onFrame);
  };

  private stopFrames(): void {
    if (this.frameRequest === undefined) return;
    this.interaction.cancelAnimationFrame(this.frameRequest);
    this.frameRequest = undefined;
  }
}

function bodyOf(model: TranscriptGroupModel, view: GroupView): GroupBody {
  if (!model.expanded) return { kind: 'none' };
  const [first, ...rest] = model.members;
  if (rest.length > 0) return { kind: 'rows' };
  return { kind: 'detail', item: first, withRow: view.title.kind === 'summary' };
}

function titleSuffix(view: GroupView, now: Instant): string {
  const { title } = view;
  if (title.kind === 'item') return statusSuffix(title.status, now);
  const failed = title.failed > 0 ? currentTheme.fg('error', ` · ${String(title.failed)} failed`) : '';
  const interrupted = title.interrupted > 0
    ? currentTheme.fg('textDim', ` · ${String(title.interrupted)} interrupted`)
    : '';
  return `${diffText(title.added, title.removed)}${failed}${interrupted}`;
}

function memberDraft(
  item: LogicalTranscriptItem,
  status: RowStatus,
  form: RowForm,
  open: boolean,
  width: number,
  now: Instant,
  previous: MemberFrame | undefined,
  separated: boolean,
): MemberDraft {
  const rowKey = `${String(item.projectionVersion)}:${form}:${statusKey(status, now)}`;
  let row: RowLines = unadornedRow([]);
  if (previous?.item.display === item.display && previous.rowKey === rowKey) row = previous.row;
  else if (form === 'line') row = singleRow(item, status, width, now);
  else if (form === 'wrapped') row = wrappedRow(item, status, width, now);
  const detail = open ? renderRowDetail(item.display, width, separated) : undefined;
  return { item, rowKey, row, detail };
}

interface TranscriptRowDetailRenderable {
  renderTranscriptRowDetail(width: number): TuiRenderLine[];
}

function isTranscriptRowDetailRenderable(
  display: Component,
): display is Component & TranscriptRowDetailRenderable {
  return 'renderTranscriptRowDetail' in display && typeof display.renderTranscriptRowDetail === 'function';
}

function renderRowDetail(
  display: Component,
  width: number,
  separated: boolean,
): RowDetail | undefined {
  if (!hasRowDetail(display)) return undefined;
  if (separated && isTranscriptRowDetailRenderable(display)) {
    return {
      lines: display.renderTranscriptRowDetail(Math.max(1, width - TITLE_INDENT.length)),
      gutterWidth: TITLE_INDENT.length,
    };
  }
  return { lines: display.renderRowDetail(width), gutterWidth: 0 };
}

function prefixFor(branch: Branch, guide: (text: string) => string): (first: boolean) => string {
  if (branch === 'bare') return () => '';
  if (branch === 'indent') return () => TITLE_INDENT;
  const first = guide(branch === 'last' ? '└ ' : '├ ');
  const rest = branch === 'last' ? '  ' : guide('│ ');
  return (isFirst) => isFirst ? first : rest;
}

function statusKey(status: RowStatus, now: Instant): string {
  return status.kind === 'running' && status.since !== undefined
    ? `running${elapsedText(status.since, now)}`
    : status.kind;
}

function statusSuffix(status: RowStatus, now: Instant): string {
  switch (status.kind) {
    case 'running': {
      const elapsed = status.since === undefined ? '' : elapsedText(status.since, now);
      return elapsed.length === 0 ? '' : currentTheme.dim(elapsed);
    }
    case 'failed': return currentTheme.dim(' · failed');
    case 'interrupted': return currentTheme.dim(' · interrupted');
    case 'done': {
      const stat = status.stat;
      if (stat === undefined) return '';
      if (stat.kind === 'note') return currentTheme.dim(` · ${stat.text}`);
      return `${currentTheme.dim(' ·')}${diffText(stat.added, stat.removed)}`;
    }
  }
}

function diffText(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(currentTheme.fg('diffAdded', `+${String(added)}`));
  if (removed > 0) parts.push(currentTheme.fg('diffRemoved', `-${String(removed)}`));
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

function rowHead(item: LogicalTranscriptItem, status: RowStatus): string {
  return currentTheme.boldFg(status.kind === 'failed' ? 'error' : 'textDim', item.label.rowVerb);
}

function rowMarker(item: LogicalTranscriptItem): string {
  const { display } = item;
  return hasStatusMarker(display) ? display.statusMarker() : TITLE_INDENT;
}

function rowLine(item: LogicalTranscriptItem, status: RowStatus, width: number, now: Instant): TuiRenderLine {
  const head = rowHead(item, status);
  const { subject } = item.label;
  return textRenderLine(renderHeaderContent({
    head: subject === undefined ? head : `${head} `,
    flex: { text: subject === undefined ? '' : oneLine(subject), style: (text) => currentTheme.dim(text), keep: 'head' },
    tail: statusSuffix(status, now),
  }, width));
}

function splitDimmedTail(text: string): { readonly gutter: string; readonly content: string } {
  const head = currentTheme.dim('└ ');
  const branch = head.indexOf('└ ');
  if (branch < 0) return { gutter: head, content: currentTheme.dim(text) };
  return { gutter: head.slice(0, branch + 2), content: `${text}${head.slice(branch + 2)}` };
}

function blankRenderLine(decoration: string): TuiRenderLine {
  const end = visibleWidth(decoration);
  if (end === 0) return textRenderLine('');
  return { text: '', selectionExclusions: [{ start: 0, end }] };
}

function wrapStructuredText(text: string, width: number): TuiRenderLine[] {
  return renderComponentLines(new Text(text, 0, 0), width)
    .map((line) => withRenderLineText(line, line.text.trimEnd()));
}

function unadornedRow(lines: readonly TuiRenderLine[]): RowLines {
  return {
    lines,
    gutterLines: lines.map(() => textRenderLine('')),
    contentLines: lines,
    gutterWidths: lines.map(() => 0),
  };
}

function singleRow(item: LogicalTranscriptItem, status: RowStatus, width: number, now: Instant): RowLines {
  return unadornedRow([rowLine(item, status, width, now)]);
}

function wrappedRow(item: LogicalTranscriptItem, status: RowStatus, width: number, now: Instant): RowLines {
  const head = rowHead(item, status);
  const suffix = statusSuffix(status, now);
  const { rowVerb, subject } = item.label;
  if (subject === undefined) return unadornedRow(wrapStructuredText(`${head}${suffix}`, width));
  const indent = visibleWidth(rowVerb) + 1;
  if (width - indent < MIN_WRAPPED_SUBJECT_WIDTH) {
    return unadornedRow(wrapStructuredText(`${head} ${currentTheme.dim(subject)}${suffix}`, width));
  }
  const wrapped = wrapStructuredText(`${currentTheme.dim(subject)}${suffix}`, width - indent);
  const contentLines = wrapped.map((line, index) => index === 0 ? prefixRenderLine(line, `${head} `) : line);
  const gutterLines = wrapped.map((_, index) => textRenderLine(index === 0 ? '' : ' '.repeat(indent)));
  return {
    lines: contentLines.map((line, index) => index === 0 ? line : prefixRenderLine(line, ' '.repeat(indent))),
    gutterLines,
    contentLines,
    gutterWidths: wrapped.map((_, index) => index === 0 ? 0 : indent),
  };
}

function sameFrameKey(left: FrameKey, right: FrameKey): boolean {
  return left.model === right.model &&
    left.width === right.width &&
    left.palette === right.palette &&
    left.background === right.background &&
    left.viewportRows === right.viewportRows &&
    left.title === right.title &&
    left.sweep === right.sweep &&
    left.rows === right.rows &&
    left.tail === right.tail;
}
