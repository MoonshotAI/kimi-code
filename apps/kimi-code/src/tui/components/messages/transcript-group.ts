import {
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
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

interface MemberDraft {
  readonly item: LogicalTranscriptItem;
  readonly rowKey: string;
  readonly row: readonly string[];
  readonly detail: readonly string[] | undefined;
}

interface MemberFrame extends MemberDraft {
  readonly branch: Branch;
  readonly lines: readonly string[];
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
  readonly title: readonly string[];
  readonly members: readonly MemberFrame[];
  readonly lines: string[];
  readonly regions: readonly HitRegion[];
}

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
    const now = monotonicNow();
    const { view, thinking } = this.paceTail(deriveGroupView(this.model, now), now);
    this.shownThinking = thinking;
    if (view.live && this.frameRequest === undefined) this.syncFrames();
    const key = this.frameKey(view, width, now);
    const previous = this.frame;
    const sameKey = previous !== undefined && sameFrameKey(previous.key, key);
    const title = sameKey ? previous.title : this.renderTitle(view, width, now);
    const sameBase = previous !== undefined &&
      previous.key.width === width &&
      previous.key.palette === key.palette &&
      previous.key.background === key.background;
    const { members, showLess } = this.renderMembers(
      view,
      width,
      now,
      title.length + 2,
      key.viewportRows,
      sameBase ? previous.members : [],
    );
    if (
      sameKey &&
      members.length === previous.members.length &&
      members.every((member, index) => member.lines === previous.members[index]?.lines)
    ) {
      return previous.lines;
    }

    const lines = ['', ...title];
    const regions: HitRegion[] = [{ start: 1, end: lines.length, action: { kind: 'toggleGroup' } }];
    if (this.model.expanded) {
      lines.push('');
      const rows = bodyOf(this.model, view).kind === 'rows';
      for (const member of members) {
        const start = lines.length;
        lines.push(...member.lines);
        regions.push({
          start,
          end: lines.length,
          action: rows ? { kind: 'toggleRow', item: member.item } : { kind: 'toggleGroup' },
        });
      }
      if (showLess) {
        const start = lines.length;
        lines.push(`${TITLE_INDENT}${chalk.hex(this.guideColor())('└ ')}${currentTheme.fg('textDim', 'Show less')}`);
        regions.push({ start, end: lines.length, action: { kind: 'showLess', removedLines: lines.length - 2 } });
      }
    }
    if (key.tail !== undefined) {
      if (!this.model.expanded && key.tail.length > 0) {
        regions.push({ start: lines.length, end: lines.length + 1, action: { kind: 'toggleGroup' } });
      }
      lines.push(key.tail.length === 0 ? '' : currentTheme.dim(`${TAIL_HEAD}${key.tail}`));
    }
    this.frame = { key, title, members, lines, regions };
    return lines;
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

  private renderTitle(view: GroupView, width: number, now: Instant): string[] {
    const paint = this.sweep.painter();
    const style = (text: string): string => paint(text, TITLE_INDENT.length);
    const suffix = titleSuffix(view, now);
    if (view.title.kind === 'item' && this.model.expanded) {
      const { verb, subject } = view.title.item.label;
      const full = subject === undefined ? verb : `${verb} ${subject}`;
      return wrapTextWithAnsi(`${style(full)}${suffix}`, Math.max(1, width - TITLE_INDENT.length))
        .map((line) => `${TITLE_INDENT}${line}`);
    }
    this.header.setText({
      head: TITLE_INDENT,
      flex: { text: titleText(view.title), style, keep: 'head' },
      tail: suffix,
    });
    return this.header.render(width);
  }

  private renderMembers(
    view: GroupView,
    width: number,
    now: Instant,
    headerHeight: number,
    viewportRows: number | undefined,
    previous: readonly MemberFrame[],
  ): { readonly members: readonly MemberFrame[]; readonly showLess: boolean } {
    const body = bodyOf(this.model, view);
    if (body.kind === 'none') return { members: [], showLess: false };
    const { timeline } = this.model;
    const inner = Math.max(1, width - 2);
    const rowColumns = Math.max(1, inner - TITLE_INDENT.length);
    const draft = (item: LogicalTranscriptItem, form: RowForm, open: boolean, columns: number, index: number): MemberDraft =>
      memberDraft(item, rowStatusOf(item, timeline, now), form, open, columns, now, previous[index]);
    const drafts = body.kind === 'detail'
      ? [draft(body.item, body.withRow ? 'wrapped' : 'none', true, body.withRow ? inner : width, 0)]
      : this.model.members.map((item, index) => {
        const open = isExpandedComponent(item.display);
        return draft(item, open ? 'wrapped' : 'line', open, rowColumns, index);
      });
    const height = headerHeight + drafts.reduce((total, member) => total + member.row.length + (member.detail?.length ?? 0), 0);
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
      const lines = [...member.row, ...(member.detail ?? [])]
        .map((line, lineIndex) => `${prefix(lineIndex === 0)}${line}`);
      return { ...member, branch, lines };
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
    if (this.disposed || (!deriveGroupView(this.model, now).live && this.sweep.intensity === 0)) {
      this.stopFrames();
      return;
    }
    if (this.frameRequest !== undefined) return;
    this.sweep.start(now);
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
  readonly detail: readonly string[] | undefined;
  readonly lines: string[];
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
    const now = monotonicNow();
    const status = rowStatusOf(this.item, this.timeline, now);
    const key = statusKey(status, now);
    const { display } = this.item;
    const open = isExpandedComponent(display);
    const detail = open && hasRowDetail(display) ? display.renderRowDetail(width) : undefined;
    const previous = this.frame;
    if (
      previous?.item === this.item &&
      previous.width === width &&
      previous.palette === currentTheme.palette &&
      previous.status === key &&
      previous.open === open &&
      previous.detail === detail
    ) {
      return previous.lines;
    }
    const marker = rowMarker(this.item);
    const indent = ' '.repeat(visibleWidth(marker));
    const columns = Math.max(1, width - indent.length);
    const row = open ? wrappedRow(this.item, status, columns, now) : [rowLine(this.item, status, columns, now)];
    const lines = ['', ...row.map((line, index) => `${index === 0 ? marker : indent}${line}`), ...(detail ?? [])];
    this.frame = { item: this.item, width, palette: currentTheme.palette, status: key, open, detail, lines };
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left' || event.y < 1) return undefined;
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
): MemberDraft {
  const rowKey = `${String(item.projectionVersion)}:${form}:${statusKey(status, now)}`;
  let row: readonly string[] = [];
  if (previous?.item.display === item.display && previous.rowKey === rowKey) row = previous.row;
  else if (form === 'line') row = [rowLine(item, status, width, now)];
  else if (form === 'wrapped') row = wrappedRow(item, status, width, now);
  const detail = open && hasRowDetail(item.display) ? item.display.renderRowDetail(width) : undefined;
  return { item, rowKey, row, detail };
}

function prefixFor(branch: Branch, guide: (text: string) => string): (first: boolean) => string {
  if (branch === 'bare') return () => '';
  if (branch === 'indent') return () => TITLE_INDENT;
  const first = `${TITLE_INDENT}${guide(branch === 'last' ? '└ ' : '├ ')}`;
  const rest = `${TITLE_INDENT}${branch === 'last' ? '  ' : guide('│ ')}`;
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

function rowLine(item: LogicalTranscriptItem, status: RowStatus, width: number, now: Instant): string {
  const head = rowHead(item, status);
  const { subject } = item.label;
  return renderHeaderContent({
    head: subject === undefined ? head : `${head} `,
    flex: { text: subject === undefined ? '' : oneLine(subject), style: (text) => currentTheme.dim(text), keep: 'head' },
    tail: statusSuffix(status, now),
  }, width);
}

function wrappedRow(item: LogicalTranscriptItem, status: RowStatus, width: number, now: Instant): string[] {
  const head = rowHead(item, status);
  const suffix = statusSuffix(status, now);
  const { rowVerb, subject } = item.label;
  if (subject === undefined) return wrapTextWithAnsi(`${head}${suffix}`, width);
  const indent = visibleWidth(rowVerb) + 1;
  if (width - indent < MIN_WRAPPED_SUBJECT_WIDTH) return wrapTextWithAnsi(`${head} ${currentTheme.dim(subject)}${suffix}`, width);
  return wrapTextWithAnsi(`${currentTheme.dim(subject)}${suffix}`, width - indent)
    .map((line, index) => `${index === 0 ? `${head} ` : ' '.repeat(indent)}${line}`);
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
