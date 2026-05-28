/**
 * MemoryBrowserApp — full-screen alt-screen takeover for browsing
 * stored memory facts. Two-pane layout (left list grouped by scope,
 * right detail with frontmatter + body) framed by a header and footer.
 *
 * The browser is read-only at the file level: deletes route back to the
 * controller via `onConfirmDelete`, which dispatches `session.deleteMemory`.
 * No code path in this component touches the filesystem directly.
 */

import {
  Container,
  Key,
  matchesKey,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import type { MemoryScope } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import type { ColorPalette } from '@/tui/theme/colors';
import { printableChar } from '@/tui/utils/printable-key';

import {
  type MemoryFactView,
  type MemoryScopeFilter,
  visibleFacts as filterVisibleFacts,
} from './state';

export type { MemoryFactView } from './state';

const ELLIPSIS = '…';
const MIN_WIDTH = 56;
const MIN_HEIGHT = 12;

const LIST_COL_MIN = 32;
const LIST_COL_MAX = 56;
const LIST_COL_RATIO = 0.38;

export interface MemoryBrowserProps {
  readonly facts: readonly MemoryFactView[];
  readonly selectedSlug: string | undefined;
  readonly selectedScope: MemoryScope | undefined;
  readonly detailOpen: boolean;
  readonly confirmingDelete: boolean;
  readonly scopeFilter: MemoryScopeFilter;
  readonly flashMessage: string | undefined;
  readonly colors: ColorPalette;
  readonly onSelect: (scope: MemoryScope, slug: string) => void;
  readonly onToggleDetail: () => void;
  readonly onCycleFilter: () => void;
  readonly onRequestDelete: (scope: MemoryScope, slug: string) => void;
  readonly onConfirmDelete: (scope: MemoryScope, slug: string) => void;
  readonly onCancelDelete: () => void;
  readonly onCancel: () => void;
}

type Row =
  | { readonly kind: 'header'; readonly label: string }
  | { readonly kind: 'fact'; readonly fact: MemoryFactView }
  | { readonly kind: 'empty'; readonly text: string };

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function buildRows(
  facts: readonly MemoryFactView[],
  filter: MemoryScopeFilter,
): readonly Row[] {
  const visible = filterVisibleFacts(facts, filter);
  const project = visible.filter((f) => f.scope === 'project');
  const user = visible.filter((f) => f.scope === 'user');

  const rows: Row[] = [];
  if (project.length === 0 && user.length === 0) {
    rows.push({ kind: 'empty', text: 'No memory facts in this session.' });
    return rows;
  }

  if (project.length > 0) {
    rows.push({ kind: 'header', label: `Project (${String(project.length)})` });
    for (const fact of project) rows.push({ kind: 'fact', fact });
  }
  if (user.length > 0) {
    rows.push({ kind: 'header', label: `User (${String(user.length)})` });
    for (const fact of user) rows.push({ kind: 'fact', fact });
  }
  return rows;
}

export class MemoryBrowserApp extends Container implements Focusable {
  focused = false;

  private props: MemoryBrowserProps;
  private readonly terminal: Terminal;
  private rows: readonly Row[];
  private listScroll = 0;

  constructor(props: MemoryBrowserProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.rows = buildRows(props.facts, props.scopeFilter);
  }

  setProps(next: MemoryBrowserProps): void {
    this.props = next;
    this.rows = buildRows(next.facts, next.scopeFilter);
    this.invalidate();
  }

  handleInput(data: string): void {
    const k = printableChar(data);

    if (this.props.confirmingDelete) {
      if (matchesKey(data, Key.enter) || k === 'y' || k === 'Y') {
        if (this.props.selectedScope !== undefined && this.props.selectedSlug !== undefined) {
          this.props.onConfirmDelete(this.props.selectedScope, this.props.selectedSlug);
        }
        return;
      }
      if (matchesKey(data, Key.escape) || k === 'n' || k === 'N') {
        this.props.onCancelDelete();
        return;
      }
      return;
    }

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.props.onToggleDetail();
      return;
    }
    if (k === 's' || k === 'S') {
      this.props.onCycleFilter();
      return;
    }
    if (k === 'd' || k === 'D') {
      if (this.props.selectedScope !== undefined && this.props.selectedSlug !== undefined) {
        this.props.onRequestDelete(this.props.selectedScope, this.props.selectedSlug);
      }
      return;
    }
  }

  private moveSelection(delta: number): void {
    const facts = this.factRowsOnly();
    if (facts.length === 0) return;
    const currentIdx = this.currentFactIndex(facts);
    const nextIdx = Math.max(0, Math.min(facts.length - 1, currentIdx + delta));
    const next = facts[nextIdx];
    if (next === undefined) return;
    if (next.scope === this.props.selectedScope && next.slug === this.props.selectedSlug) return;
    this.props.onSelect(next.scope, next.slug);
  }

  private factRowsOnly(): readonly MemoryFactView[] {
    const out: MemoryFactView[] = [];
    for (const row of this.rows) if (row.kind === 'fact') out.push(row.fact);
    return out;
  }

  private currentFactIndex(facts: readonly MemoryFactView[]): number {
    if (this.props.selectedScope === undefined || this.props.selectedSlug === undefined) return 0;
    const idx = facts.findIndex(
      (f) => f.scope === this.props.selectedScope && f.slug === this.props.selectedSlug,
    );
    return idx === -1 ? 0 : idx;
  }

  override render(width: number): string[] {
    const rows = Math.max(1, this.terminal.rows);
    if (width < MIN_WIDTH || rows < MIN_HEIGHT) {
      return this.renderTooSmall(width, rows);
    }

    const header = this.renderHeader(width);
    const footer = this.renderFooter(width);
    const bodyHeight = rows - 2;

    const listWidth = Math.max(
      LIST_COL_MIN,
      Math.min(LIST_COL_MAX, Math.floor(width * LIST_COL_RATIO)),
    );
    const detailWidth = width - listWidth;

    const listFrame = this.renderListFrame(listWidth, bodyHeight);
    const detailFrame = this.renderDetailFrame(detailWidth, bodyHeight);

    const lines: string[] = [header];
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(
        (listFrame[i] ?? ' '.repeat(listWidth)) +
          (detailFrame[i] ?? ' '.repeat(detailWidth)),
      );
    }
    lines.push(footer);
    return lines;
  }

  private renderHeader(width: number): string {
    const colors = this.props.colors;
    const title = chalk.hex(colors.primary).bold(' MEMORY ');
    const filterText = chalk.hex(colors.textMuted)(
      ` filter=${this.props.scopeFilter.toUpperCase()} `,
    );
    const total = this.props.facts.length;
    const totals = chalk.hex(colors.textMuted)(` ${String(total)} total `);
    return fitExactly(title + filterText + totals, width);
  }

  private renderFooter(width: number): string {
    const colors = this.props.colors;
    const key = (text: string): string => chalk.hex(colors.primary).bold(text);
    const dim = (text: string): string => chalk.hex(colors.textMuted)(text);

    if (this.props.confirmingDelete) {
      const slug = this.props.selectedSlug ?? '';
      const warn = (text: string): string => chalk.hex(colors.warning).bold(text);
      const line =
        ` ${warn('Delete')} ${chalk.hex(colors.text)(slug)}? ` +
        `${key('Enter')} ${dim('confirm')}  ${key('Esc')} ${dim('cancel')} `;
      return fitExactly(line, width);
    }

    const parts = [
      ` ${key('↑↓')} ${dim('select')}`,
      `${key('Enter')} ${dim('detail')}`,
      `${key('D')} ${dim('delete')}`,
      `${key('S')} ${dim('scope')}`,
      `${key('Q/Esc')} ${dim('exit')} `,
    ];
    const left = parts.join('  ');
    const flash = this.props.flashMessage;
    if (flash !== undefined && flash.length > 0) {
      const flashStyled = chalk.hex(colors.warning)(` ${flash} `);
      const total = visibleWidth(left) + visibleWidth(flashStyled);
      if (total <= width) {
        return left + ' '.repeat(width - total) + flashStyled;
      }
    }
    return fitExactly(left, width);
  }

  private renderFrame(
    title: string,
    content: readonly string[],
    width: number,
    height: number,
  ): string[] {
    if (height < 2 || width < 4) {
      const out: string[] = [];
      for (let i = 0; i < height; i++) out.push(' '.repeat(width));
      return out;
    }
    const stroke = this.props.colors.primary;
    const innerWidth = width - 2;
    const innerHeight = height - 2;

    const titleStyled = chalk.hex(this.props.colors.textStrong).bold(title);
    const titleWidth = visibleWidth(titleStyled);
    const titleSegment = `─ ${titleStyled} `;
    const titleSegmentWidth = visibleWidth(titleSegment);
    const remainingDashes = Math.max(0, innerWidth - titleSegmentWidth);
    const topMid =
      titleWidth > 0 && titleSegmentWidth <= innerWidth
        ? chalk.hex(stroke)('─ ') +
          titleStyled +
          ' ' +
          chalk.hex(stroke)('─'.repeat(remainingDashes))
        : chalk.hex(stroke)('─'.repeat(innerWidth));
    const top = chalk.hex(stroke)('┌') + topMid + chalk.hex(stroke)('┐');
    const bottom = chalk.hex(stroke)('└' + '─'.repeat(innerWidth) + '┘');

    const lines: string[] = [top];
    for (let i = 0; i < innerHeight; i++) {
      const inner = content[i] ?? '';
      lines.push(chalk.hex(stroke)('│') + fitExactly(inner, innerWidth) + chalk.hex(stroke)('│'));
    }
    lines.push(bottom);
    return lines;
  }

  private renderListFrame(width: number, height: number): string[] {
    const innerWidth = width - 2;
    const innerHeight = Math.max(0, height - 2);

    if (this.rows.length === 0 || this.rows.every((r) => r.kind === 'empty')) {
      const empty = this.rows[0]?.kind === 'empty' ? this.rows[0].text : 'No memory facts.';
      const lines: string[] = [chalk.hex(this.props.colors.textMuted)(empty)];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame('Facts', lines, width, height);
    }

    this.adjustScroll(innerHeight);
    const start = this.listScroll;
    const window = this.rows.slice(start, start + innerHeight);
    const lines: string[] = [];
    for (const row of window) {
      lines.push(this.renderRow(row, innerWidth));
    }
    while (lines.length < innerHeight) lines.push('');
    return this.renderFrame('Facts', lines, width, height);
  }

  private renderRow(row: Row, innerWidth: number): string {
    const colors = this.props.colors;
    if (row.kind === 'header') {
      return chalk.hex(colors.textStrong).bold(fitExactly(row.label, innerWidth));
    }
    if (row.kind === 'empty') {
      return fitExactly(chalk.hex(colors.textMuted)(row.text), innerWidth);
    }
    const fact = row.fact;
    const selected =
      fact.scope === this.props.selectedScope && fact.slug === this.props.selectedSlug;
    const pointer = selected ? '> ' : '  ';
    const pointerStyled = chalk.hex(selected ? colors.primary : colors.textDim)(pointer);

    const slugColor = selected ? colors.primary : colors.text;
    const slugText = selected
      ? chalk.hex(slugColor).bold(fact.slug)
      : chalk.hex(slugColor)(fact.slug);
    const typeBadge = chalk.hex(colors.textMuted)(`(${fact.type})`);

    let suffix = '';
    if (fact.shadowed) suffix = ` ${chalk.hex(colors.warning)('[shadowed by project]')}`;

    const prefix = `${pointerStyled}${slugText} ${typeBadge}`;
    const prefixWidth = visibleWidth(prefix);
    const suffixWidth = visibleWidth(suffix);
    const descBudget = Math.max(0, innerWidth - prefixWidth - suffixWidth - 3);
    if (descBudget < 4) return fitExactly(prefix + suffix, innerWidth);

    const desc = truncateToWidth(singleLine(fact.description), descBudget, ELLIPSIS);
    return fitExactly(
      `${prefix} — ${chalk.hex(colors.textMuted)(desc)}${suffix}`,
      innerWidth,
    );
  }

  private adjustScroll(visibleRows: number): void {
    if (visibleRows <= 0) {
      this.listScroll = 0;
      return;
    }
    const facts = this.factRowsOnly();
    const factIndex = this.currentFactIndex(facts);
    // Map fact index back to row index (account for headers above it).
    let rowIndex = -1;
    let seenFacts = 0;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]!;
      if (row.kind === 'fact') {
        if (seenFacts === factIndex) {
          rowIndex = i;
          break;
        }
        seenFacts += 1;
      }
    }
    if (rowIndex === -1) {
      this.listScroll = 0;
      return;
    }
    if (rowIndex < this.listScroll) {
      this.listScroll = rowIndex;
    } else if (rowIndex >= this.listScroll + visibleRows) {
      this.listScroll = rowIndex - visibleRows + 1;
    }
    const maxScroll = Math.max(0, this.rows.length - visibleRows);
    if (this.listScroll < 0) this.listScroll = 0;
    if (this.listScroll > maxScroll) this.listScroll = maxScroll;
  }

  private renderDetailFrame(width: number, height: number): string[] {
    const colors = this.props.colors;
    const innerWidth = width - 2;
    const innerHeight = Math.max(0, height - 2);
    const fact = this.selectedFact();
    if (fact === undefined) {
      const lines: string[] = [chalk.hex(colors.textMuted)('Select a fact to preview.')];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame('Detail (read-only)', lines, width, height);
    }

    const showBody = this.props.detailOpen || true; // Detail pane always shows the body.
    if (!showBody) {
      const lines: string[] = [chalk.hex(colors.textMuted)('Press Enter to preview.')];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame('Detail (read-only)', lines, width, height);
    }

    const lines: string[] = [
      chalk.hex(colors.textStrong).bold(fact.slug),
      chalk.hex(colors.textMuted)(`${fact.scope} · ${fact.type}`),
    ];
    if (fact.shadowed) {
      lines.push(chalk.hex(colors.warning)('shadowed by project'));
    }
    lines.push('');

    for (const raw of fact.body.split('\n')) {
      const wrapped = wrapText(raw, innerWidth);
      for (const wline of wrapped) {
        lines.push(chalk.hex(colors.text)(wline));
      }
    }

    while (lines.length < innerHeight) lines.push('');
    return this.renderFrame('Detail (read-only)', lines.slice(0, innerHeight), width, height);
  }

  private selectedFact(): MemoryFactView | undefined {
    if (this.props.selectedScope === undefined || this.props.selectedSlug === undefined)
      return this.props.facts[0];
    return this.props.facts.find(
      (f) => f.scope === this.props.selectedScope && f.slug === this.props.selectedSlug,
    );
  }

  private renderTooSmall(width: number, rows: number): string[] {
    const lines: string[] = [];
    const msg = chalk.hex(this.props.colors.error)(
      `Terminal too small (need ≥ ${String(MIN_WIDTH)} × ${String(MIN_HEIGHT)})`,
    );
    lines.push(fitExactly(msg, width));
    while (lines.length < rows) lines.push(fitExactly('', width));
    return lines;
  }
}

function wrapText(line: string, width: number): string[] {
  if (width <= 0) return [''];
  if (visibleWidth(line) <= width) return [line];
  const out: string[] = [];
  let remaining = line;
  while (visibleWidth(remaining) > width) {
    out.push(truncateToWidth(remaining, width, ''));
    // Drop the same number of code points we just printed. Approximate
    // by counting visible chars — preview pane only renders frontmatter
    // and body fragments, none of which use complex grapheme clusters.
    let count = 0;
    let idx = 0;
    for (const ch of remaining) {
      if (count >= width) break;
      idx += ch.length;
      count += visibleWidth(ch);
    }
    remaining = remaining.slice(idx);
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}
