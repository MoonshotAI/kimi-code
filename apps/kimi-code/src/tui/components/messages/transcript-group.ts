import {
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { TRANSCRIPT_GROUP_HOLD_MS } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import { mixColors } from '#/tui/theme/color-mix';
import { hasRowDetail, isExpandedComponent } from '#/tui/utils/component-capabilities';
import type { ItemStatus, LogicalTranscriptItem } from '#/tui/utils/transcript-items';
import type { GroupSummary } from '#/tui/utils/transcript-projection';
import { elapsedSuffix, shownSeconds, TitleSweep } from './running-title';
import { renderHeaderContent, TruncatedHeaderLine } from './truncated-header-line';

export interface TranscriptGroupModel {
  readonly anchor: Component;
  readonly sourceIndex: number;
  readonly members: readonly [LogicalTranscriptItem, ...LogicalTranscriptItem[]];
  readonly active: boolean;
  readonly expanded: boolean;
  readonly summary: GroupSummary;
}

export interface TranscriptGroupInteraction {
  toggleGroup(anchor: Component, fromBottom?: { readonly removedLines: number }): void;
  toggleRow(item: LogicalTranscriptItem): boolean;
  viewportRows(): number | undefined;
  requestRender(): void;
  requestAnimationFrame(callback: (time: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

type GroupTitle =
  | { readonly kind: 'summary' }
  | { readonly kind: 'item'; readonly item: LogicalTranscriptItem };

type GroupBody =
  | { readonly kind: 'tail'; readonly items: readonly LogicalTranscriptItem[] }
  | { readonly kind: 'rows' }
  | { readonly kind: 'detail'; readonly item: LogicalTranscriptItem; readonly withRow: boolean };

interface GroupShape {
  readonly title: GroupTitle;
  readonly body: GroupBody;
}

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
  readonly width: number;
  readonly palette: ColorPalette;
  readonly background: string;
  readonly summary: GroupSummary;
  readonly expanded: boolean;
  readonly active: boolean;
  readonly animationKey: string;
  readonly tailKey: string;
  readonly viewportRows: number | undefined;
}

interface Frame {
  readonly key: FrameKey;
  readonly title: readonly string[];
  readonly members: readonly MemberFrame[];
  readonly lines: string[];
  readonly regions: readonly HitRegion[];
}

const MARKER = '●';
const MIN_WRAPPED_SUBJECT_WIDTH = 8;

export class TranscriptGroupComponent implements Component {
  private model: TranscriptGroupModel;
  private readonly header = new TruncatedHeaderLine('');
  private frame: Frame | undefined;
  private frameRequest: number | undefined;
  private disposed = false;
  private readonly sweep = new TitleSweep();
  private lastActiveAt: number | undefined;
  private shownAnimation: string | undefined;

  constructor(
    model: TranscriptGroupModel,
    private readonly interaction: TranscriptGroupInteraction,
  ) {
    this.model = model;
    this.syncFrames();
  }

  setModel(model: TranscriptGroupModel): void {
    if (this.model.active) this.lastActiveAt = Date.now();
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
    const now = Date.now();
    const shape = shapeOf(this.model);
    const previous = this.frame;
    const base = {
      width,
      palette: currentTheme.palette,
      background: currentTheme.terminalBackground(),
      summary: this.model.summary,
      expanded: this.model.expanded,
      active: this.model.active,
      viewportRows: this.interaction.viewportRows(),
    };
    if (
      shape.body.kind === 'tail' &&
      !this.needsClock(now) &&
      previous !== undefined &&
      sameFrameKey(previous.key, { ...base, animationKey: 'static', tailKey: '' })
    ) {
      return previous.lines;
    }

    const titleText = titleTextOf(shape, this.model.summary);
    const animationKey = this.sweep.frameKey;
    const tail = shape.body.kind === 'tail' ? shape.body.items : [];
    const key: FrameKey = {
      ...base,
      animationKey,
      tailKey: tail.map((item) => `${String(item.projectionVersion)}:${String(elapsedSeconds(item.status, now))}`).join('|'),
    };
    const sameKey = previous !== undefined && sameFrameKey(previous.key, key);
    const title = sameKey ? previous.title : this.renderTitle(shape, titleText, width, now);
    const sameBase = previous !== undefined &&
      previous.key.width === width &&
      previous.key.palette === base.palette &&
      previous.key.background === base.background;
    const { members, showLess } = this.renderMembers(
      shape,
      width,
      now,
      title.length + 2,
      base.viewportRows,
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
    for (const [index, item] of tail.entries()) {
      lines.push(tailLine(item, index < tail.length - 1 ? '├ ' : '└ ', width, now));
    }
    const regions: HitRegion[] = [{ start: 1, end: lines.length, action: { kind: 'toggleGroup' } }];
    if (shape.body.kind !== 'tail') lines.push('');
    for (const member of members) {
      const start = lines.length;
      lines.push(...member.lines);
      regions.push({
        start,
        end: lines.length,
        action: shape.body.kind === 'rows' ? { kind: 'toggleRow', item: member.item } : { kind: 'toggleGroup' },
      });
    }
    if (showLess) {
      const start = lines.length;
      lines.push(`${chalk.hex(this.guideColor())('└ ')}${currentTheme.fg('textDim', 'Show less')}`);
      regions.push({
        start,
        end: lines.length,
        action: { kind: 'showLess', removedLines: Math.max(0, lines.length - collapsedHeight(this.model)) },
      });
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

  private renderTitle(shape: GroupShape, text: string, width: number, now: number): string[] {
    const { summary } = this.model;
    const offset = visibleWidth(MARKER) + 1;
    const paint = this.sweep.painter();
    let markerStyle = (value: string): string => paint(value, 0);
    const textStyle = (value: string): string => paint(value, offset);
    if (summary.allFailed) markerStyle = (value) => currentTheme.fg('error', value);
    const head = `${markerStyle(MARKER)} `;

    if (shape.title.kind === 'item') {
      const { item } = shape.title;
      const suffix = statusSuffix(item.status, now);
      if (shape.body.kind === 'detail') {
        const { verb, subject } = item.label;
        const full = subject === undefined ? verb : `${verb} ${subject}`;
        return wrapTextWithAnsi(`${textStyle(full)}${suffix}`, Math.max(1, width - 2))
          .map((line, index) => `${index === 0 ? head : '  '}${line}`);
      }
      this.header.setText({ head, flex: { text, style: textStyle, keep: 'head' }, tail: suffix });
      return this.header.render(width);
    }

    const failed = summary.failed > 0
      ? currentTheme.fg('error', ` · ${String(summary.failed)} failed`)
      : '';
    const interrupted = summary.interrupted > 0
      ? currentTheme.fg('textDim', ` · ${String(summary.interrupted)} interrupted`)
      : '';
    this.header.setText({
      head,
      flex: { text, style: textStyle, keep: 'head' },
      tail: `${diffText(summary.added, summary.removed)}${failed}${interrupted}`,
    });
    return this.header.render(width);
  }

  private renderMembers(
    shape: GroupShape,
    width: number,
    now: number,
    headerHeight: number,
    viewportRows: number | undefined,
    previous: readonly MemberFrame[],
  ): { readonly members: readonly MemberFrame[]; readonly showLess: boolean } {
    const body = shape.body;
    if (body.kind === 'tail') return { members: [], showLess: false };
    const inner = Math.max(1, width - 2);
    const drafts = body.kind === 'detail'
      ? [memberDraft(body.item, body.withRow ? 'wrapped' : 'none', true, body.withRow ? inner : width, now, previous[0])]
      : this.model.members.map((item, index) => {
        const open = isExpandedComponent(item.display);
        return memberDraft(item, open ? 'wrapped' : 'line', open, inner, now, previous[index]);
      });
    const height = headerHeight + drafts.reduce((total, draft) => total + draft.row.length + (draft.detail?.length ?? 0), 0);
    const showLess = overflows(height, viewportRows);
    const guide = (text: string): string => chalk.hex(this.guideColor())(text);
    const members = drafts.map((draft, index): MemberFrame => {
      let branch: Branch = 'bare';
      if (body.kind === 'rows') branch = index === drafts.length - 1 && !showLess ? 'last' : 'middle';
      else if (body.withRow) branch = 'indent';
      const reused = previous[index];
      if (
        reused !== undefined &&
        reused.item.display === draft.item.display &&
        reused.row === draft.row &&
        reused.detail === draft.detail &&
        reused.branch === branch
      ) {
        return { ...reused, item: draft.item };
      }
      const prefix = prefixFor(branch, guide);
      const lines = [...draft.row, ...(draft.detail ?? [])]
        .map((line, lineIndex) => `${prefix(lineIndex === 0)}${line}`);
      return { ...draft, branch, lines };
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

  private holding(now: number): boolean {
    return this.lastActiveAt !== undefined && now - this.lastActiveAt < TRANSCRIPT_GROUP_HOLD_MS;
  }

  private needsClock(now: number): boolean {
    if (this.model.active || this.sweep.intensity > 0 || this.holding(now)) return true;
    const body = shapeOf(this.model).body;
    switch (body.kind) {
      case 'tail': return body.items.some((item) => item.status.kind === 'running');
      case 'rows': return this.model.members.some((item) => item.status.kind === 'running');
      case 'detail': return body.withRow;
    }
  }

  private syncFrames(): void {
    if (this.disposed || !this.needsClock(Date.now())) {
      this.stopFrames();
      return;
    }
    if (this.frameRequest !== undefined) return;
    this.sweep.start(performance.now());
    this.frameRequest = this.interaction.requestAnimationFrame(this.onFrame);
  }

  private readonly onFrame = (time: number): void => {
    this.frameRequest = undefined;
    const now = Date.now();
    const columns = visibleWidth(`${MARKER} ${titleTextOf(shapeOf(this.model), this.model.summary)}`);
    this.sweep.advance(time, columns, this.model.active || this.holding(now));
    const seconds = this.model.members.map((item) => elapsedSeconds(item.status, now)).join(',');
    const shown = `${this.sweep.frameKey}|${seconds}`;
    if (shown !== this.shownAnimation) {
      this.shownAnimation = shown;
      this.interaction.requestRender();
    }
    if (this.needsClock(now)) this.frameRequest = this.interaction.requestAnimationFrame(this.onFrame);
  };

  private stopFrames(): void {
    if (this.frameRequest === undefined) return;
    this.interaction.cancelAnimationFrame(this.frameRequest);
    this.frameRequest = undefined;
  }
}

function titleTextOf(shape: GroupShape, summary: GroupSummary): string {
  return shape.title.kind === 'summary' ? summary.fragments.join(', ') : itemText(shape.title.item);
}

function shapeOf(model: TranscriptGroupModel): GroupShape {
  const [first, ...rest] = model.members;
  const only = rest.length === 0 ? first : undefined;
  const title: GroupTitle = only !== undefined && only.status.kind !== 'running'
    ? { kind: 'item', item: only }
    : { kind: 'summary' };
  if (!model.expanded) {
    return {
      title,
      body: { kind: 'tail', items: title.kind === 'summary' && model.active ? tailItems(model.members) : [] },
    };
  }
  if (only !== undefined) return { title, body: { kind: 'detail', item: only, withRow: title.kind === 'summary' } };
  return { title, body: { kind: 'rows' } };
}

function tailItems(members: readonly LogicalTranscriptItem[]): readonly LogicalTranscriptItem[] {
  const running = members.filter((member) => member.status.kind === 'running');
  const shown = running.length > 0 ? running : members.slice(-1);
  return shown.filter((member) => member.family === 'tool');
}

function collapsedHeight(model: TranscriptGroupModel): number {
  const body = shapeOf({ ...model, expanded: false }).body;
  return 2 + (body.kind === 'tail' ? body.items.length : 0);
}

function memberDraft(
  item: LogicalTranscriptItem,
  form: RowForm,
  open: boolean,
  width: number,
  now: number,
  previous: MemberFrame | undefined,
): MemberDraft {
  const rowKey = `${String(item.projectionVersion)}:${item.status.kind}:${form}:${String(elapsedSeconds(item.status, now))}`;
  let row: readonly string[] = [];
  if (previous?.item.display === item.display && previous.rowKey === rowKey) row = previous.row;
  else if (form === 'line') row = [rowLine(item, width, now)];
  else if (form === 'wrapped') row = wrappedRow(item, width, now);
  const detail = open && hasRowDetail(item.display) ? item.display.renderRowDetail(width) : undefined;
  return { item, rowKey, row, detail };
}

function overflows(height: number, viewportRows: number | undefined): boolean {
  return viewportRows !== undefined && height > viewportRows;
}

function prefixFor(branch: Branch, guide: (text: string) => string): (first: boolean) => string {
  if (branch === 'bare') return () => '';
  if (branch === 'indent') return () => '  ';
  const first = guide(branch === 'last' ? '└ ' : '├ ');
  const rest = branch === 'last' ? '  ' : guide('│ ');
  return (isFirst) => isFirst ? first : rest;
}

function oneLine(subject: string): string {
  const newline = subject.indexOf('\n');
  return newline < 0 ? subject : `${subject.slice(0, newline)}…`;
}

export function itemText(item: LogicalTranscriptItem): string {
  const { verb, subject } = item.label;
  return subject === undefined ? verb : `${verb} ${oneLine(subject)}`;
}

function elapsedSeconds(status: ItemStatus, now: number): number | undefined {
  return status.kind === 'running' ? shownSeconds(status.startedAtMs, now) : undefined;
}

function statusSuffix(status: ItemStatus, now: number): string {
  switch (status.kind) {
    case 'running': return elapsedSuffix(status.startedAtMs, now);
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

function rowHead(item: LogicalTranscriptItem): string {
  return currentTheme.boldFg(item.status.kind === 'failed' ? 'error' : 'textDim', item.label.rowVerb);
}

function rowLine(item: LogicalTranscriptItem, width: number, now: number): string {
  const head = rowHead(item);
  const { subject } = item.label;
  return renderHeaderContent({
    head: subject === undefined ? head : `${head} `,
    flex: { text: subject === undefined ? '' : oneLine(subject), style: (text) => currentTheme.dim(text), keep: 'head' },
    tail: statusSuffix(item.status, now),
  }, width);
}

function wrappedRow(item: LogicalTranscriptItem, width: number, now: number): string[] {
  const head = rowHead(item);
  const suffix = statusSuffix(item.status, now);
  const { rowVerb, subject } = item.label;
  if (subject === undefined) return wrapTextWithAnsi(`${head}${suffix}`, width);
  const indent = visibleWidth(rowVerb) + 1;
  if (width - indent < MIN_WRAPPED_SUBJECT_WIDTH) return wrapTextWithAnsi(`${head} ${currentTheme.dim(subject)}${suffix}`, width);
  return wrapTextWithAnsi(`${currentTheme.dim(subject)}${suffix}`, width - indent)
    .map((line, index) => `${index === 0 ? `${head} ` : ' '.repeat(indent)}${line}`);
}

function tailLine(item: LogicalTranscriptItem, branch: string, width: number, now: number): string {
  const seconds = elapsedSeconds(item.status, now);
  const line = renderHeaderContent({
    head: branch,
    flex: { text: itemText(item), keep: 'head' },
    tail: seconds === undefined ? '' : ` · ${String(seconds)}s`,
  }, width);
  return currentTheme.dim(line);
}

function sameFrameKey(left: FrameKey, right: FrameKey): boolean {
  return left.width === right.width &&
    left.palette === right.palette &&
    left.background === right.background &&
    left.summary === right.summary &&
    left.expanded === right.expanded &&
    left.active === right.active &&
    left.animationKey === right.animationKey &&
    left.tailKey === right.tailKey &&
    left.viewportRows === right.viewportRows;
}
