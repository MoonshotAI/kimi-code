import type { ProviderConfig } from '@moonshot-ai/kimi-code-sdk';
import {
  getOpenPlatformById,
  isOpenPlatformId,
  type CustomRegistrySource,
} from '@moonshot-ai/kimi-code-oauth';
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import {
  focusOnUnfocusedClick,
  ListMouseTracker,
  renderInlineSegments,
  SpanHitMap,
  type InlineSegment,
} from '#/tui/utils/mouse-regions';
import { printableChar } from '#/tui/utils/printable-key';
import { pageView, type PageView } from '#/tui/utils/paging';

interface ConfirmState {
  readonly label: string;
  readonly providerIds: readonly string[];
}

export interface ProviderManagerOptions {
  readonly providers: Record<string, ProviderConfig>;
  readonly activeProviderId?: string;
  readonly onAdd: () => void;
  readonly onDeleteSource: (providerIds: readonly string[]) => void;
  readonly onClose: () => void;
}

interface SourceRow {
  readonly kind: 'source';
  readonly id: string;
  readonly label: string;
  readonly providerIds: readonly string[];
  readonly hasActive: boolean;
  readonly baseUrl?: string;
}

interface AddRow {
  readonly kind: 'add';
  readonly id: '__add__';
  readonly label: string;
}

type Row = SourceRow | AddRow;

const ADD_ROW_LABEL = '[ Add New Platform ]';
const PAGE_SIZE = 8;
const HEADER_HINT = '↑↓ navigate · D delete · Esc cancel';

function readCustomRegistrySource(provider: unknown): CustomRegistrySource | undefined {
  if (typeof provider !== 'object' || provider === null) return undefined;
  const source = (provider as { readonly source?: unknown }).source;
  if (typeof source !== 'object' || source === null) return undefined;
  const candidate = source as {
    readonly kind?: unknown;
    readonly url?: unknown;
    readonly apiKey?: unknown;
  };
  if (candidate.kind !== 'apiJson') return undefined;
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) return undefined;
  if (typeof candidate.apiKey !== 'string') return undefined;
  return { kind: 'apiJson', url: candidate.url, apiKey: candidate.apiKey };
}

function sourceUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return url;
  }
}

function buildRows(opts: ProviderManagerOptions): readonly Row[] {
  const sources: SourceRow[] = [];

  const customRegistryIndex = new Map<string, number>();

  for (const [id, cfg] of Object.entries(opts.providers)) {
    if (id === DEFAULT_OAUTH_PROVIDER_NAME) continue;

    const isActive = id === opts.activeProviderId;

    if (isOpenPlatformId(id)) {
      const platform = getOpenPlatformById(id);
      sources.push({
        kind: 'source',
        id: `open:${id}`,
        label: platform?.name ?? id,
        providerIds: [id],
        hasActive: isActive,
      });
      continue;
    }

    const baseUrl =
      typeof cfg === 'object' && cfg !== null && 'baseUrl' in cfg && typeof cfg.baseUrl === 'string'
        ? cfg.baseUrl
        : undefined;

    const customSource = readCustomRegistrySource(cfg);
    if (customSource !== undefined) {
      const key = `${customSource.url}${customSource.apiKey}`;
      const existingIdx = customRegistryIndex.get(key);
      if (existingIdx !== undefined) {
        const existing = sources[existingIdx];
        if (existing !== undefined && existing.kind === 'source') {
          sources[existingIdx] = {
            kind: 'source',
            id: existing.id,
            label: existing.label,
            providerIds: [...existing.providerIds, id],
            hasActive: existing.hasActive || isActive,
            baseUrl: existing.baseUrl,
          };
        }
        continue;
      }
      customRegistryIndex.set(key, sources.length);
      sources.push({
        kind: 'source',
        id: `custom:${key}`,
        label: sourceUrlLabel(customSource.url),
        providerIds: [id],
        hasActive: isActive,
        baseUrl,
      });
      continue;
    }

    sources.push({
      kind: 'source',
      id: `provider:${id}`,
      label: id,
      providerIds: [id],
      hasActive: isActive,
      baseUrl,
    });
  }

  return [...sources, { kind: 'add', id: '__add__', label: ADD_ROW_LABEL }];
}

export class ProviderManagerComponent implements Component, Focusable {
  focused = false;
  private opts: ProviderManagerOptions;
  private rows: readonly Row[];
  private selectedIndex: number;
  private confirm: ConfirmState | undefined;
  private readonly listMouse = new ListMouseTracker<number>();
  private readonly confirmHits = new SpanHitMap<'confirm' | 'cancel'>();

  constructor(opts: ProviderManagerOptions) {
    this.opts = opts;
    this.rows = buildRows(opts);
    const activeIdx = opts.activeProviderId
      ? this.rows.findIndex(
          (row) => row.kind === 'source' && row.providerIds.includes(opts.activeProviderId ?? ''),
        )
      : -1;
    this.selectedIndex = Math.max(activeIdx, 0);
    this.confirm = undefined;
  }

  invalidate(): void {}

  setOptions(next: ProviderManagerOptions): void {
    const previousSelected = this.rows[this.selectedIndex];
    const previousSelectedId = previousSelected?.id;
    const previousFirstProviderId =
      previousSelected?.kind === 'source' ? previousSelected.providerIds[0] : undefined;

    this.opts = next;
    this.rows = buildRows(next);
    this.confirm = undefined;
    this.confirmHits.reset();
    this.listMouse.reset();
    this.listMouse.resetSettling();

    let newIdx = -1;
    if (previousSelectedId !== undefined) {
      newIdx = this.rows.findIndex((row) => row.id === previousSelectedId);
    }
    if (newIdx < 0 && previousFirstProviderId !== undefined) {
      newIdx = this.rows.findIndex(
        (row) => row.kind === 'source' && row.providerIds.includes(previousFirstProviderId),
      );
    }
    if (newIdx < 0) {
      newIdx = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
    }
    this.selectedIndex = newIdx;
    this.invalidate();
  }

  private page(): PageView {
    return pageView(this.rows.length, this.selectedIndex, PAGE_SIZE);
  }

  handleInput(data: string): void {
    if (this.confirm !== undefined) {
      this.handleConfirmInput(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.opts.onClose();
      return;
    }

    const rows = this.rows;

    if (matchesKey(data, Key.up)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + 1);
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.left) || matchesKey(data, Key.pageUp)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - PAGE_SIZE);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.pageDown)) {
      if (rows.length === 0) return;
      this.selectedIndex = Math.min(rows.length - 1, this.selectedIndex + PAGE_SIZE);
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = rows[this.selectedIndex];
      if (selected?.kind === 'add') {
        this.opts.onAdd();
      }
      return;
    }

    const ch = printableChar(data);
    if (ch === 'd' || ch === 'D') {
      this.armDeleteConfirm();
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.confirm !== undefined) {
      if (!this.focused) return focusOnUnfocusedClick(false, event);
      if (event.type === 'wheel') return { handled: true };
      return this.confirmHits.handle(event, {
        focused: this.focused,
        onActivate: (action) => {
          if (action === 'confirm') {
            this.confirmDelete();
          } else {
            this.cancelDelete();
          }
        },
      });
    }

    return this.listMouse.handle(event, {
      focused: this.focused,
      onHover: (index) => this.selectIndex(index),
      onWheel: (delta) => this.wheelPage(delta),
      onActivate: (index) => {
        this.selectIndex(index);
        const selected = this.rows[index];
        if (selected?.kind === 'add') {
          this.opts.onAdd();
        }
      },
    });
  }

  private selectIndex(index: number): boolean {
    if (this.rows.length === 0) return false;
    const next = Math.min(Math.max(0, Math.floor(index)), this.rows.length - 1);
    if (next === this.selectedIndex) return false;
    this.selectedIndex = next;
    this.invalidate();
    return true;
  }

  private wheelPage(delta: number): boolean {
    if (!Number.isFinite(delta) || delta === 0) return false;
    const view = this.page();
    if (view.pageCount <= 1) return false;
    if (delta < 0) {
      if (view.page === 0) return false;
      this.selectedIndex = Math.max(0, this.selectedIndex - PAGE_SIZE);
      this.invalidate();
      return true;
    }
    if (view.page >= view.pageCount - 1) return false;
    this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + PAGE_SIZE);
    this.invalidate();
    return true;
  }

  private armDeleteConfirm(): void {
    const selected = this.rows[this.selectedIndex];
    if (selected === undefined || selected.kind === 'add') return;
    const ids = selected.providerIds;
    const prompt =
      ids.length === 1
        ? `Delete platform "${selected.label}"?`
        : `Delete platform "${selected.label}" and all ${String(ids.length)} providers?`;
    this.confirm = {
      label: prompt,
      providerIds: ids,
    };
    this.confirmHits.resetSettling();
    this.invalidate();
  }

  private cancelDelete(): void {
    this.confirm = undefined;
    this.confirmHits.reset();
    this.invalidate();
  }

  private confirmDelete(): void {
    const confirm = this.confirm;
    this.confirm = undefined;
    this.confirmHits.reset();
    this.invalidate();
    if (confirm === undefined) return;
    this.opts.onDeleteSource(confirm.providerIds);
  }

  private handleConfirmInput(data: string): void {
    const k = printableChar(data);
    if (matchesKey(data, Key.escape) || k === 'n' || k === 'N') {
      this.cancelDelete();
      return;
    }
    if (k === 'y' || k === 'Y') {
      this.confirmDelete();
    }
  }

  render(width: number): string[] {
    this.listMouse.reset();
    this.confirmHits.reset();
    const lines: string[] = [];

    const border = currentTheme.fg('primary', '─'.repeat(width));
    lines.push(border);
    lines.push(currentTheme.boldFg('primary', ' Providers'));
    lines.push(currentTheme.fg('textMuted', ' ' + HEADER_HINT));
    lines.push('');

    const rows = this.rows;
    if (rows.length === 0) {
      lines.push(currentTheme.fg('textMuted', '  No providers configured.'));
    } else {
      const view = this.page();
      for (let i = view.start; i < view.end; i++) {
        const row = rows[i];
        if (row === undefined) continue;
        this.listMouse.track(lines, i, () => {
          for (const line of renderRow(row, { isSelected: i === this.selectedIndex, width })) {
            lines.push(line);
          }
        });
      }
    }

    lines.push('');

    if (this.confirm !== undefined) {
      const confirmRow = lines.length;
      lines.push(this.renderConfirmLine(width, confirmRow));
    } else {
      const view = this.page();
      if (view.pageCount > 1) {
        lines.push(
          currentTheme.fg(
            'textMuted',
            ` Page ${String(view.page + 1)}/${String(view.pageCount)}`,
          ),
        );
      }
    }

    lines.push(border);
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderConfirmLine(width: number, row: number): string {
    const confirm = this.confirm;
    const prompt = confirm?.label ?? '';
    const style = (text: string): string => currentTheme.boldFg('warning', text);
    const segments: InlineSegment<'confirm' | 'cancel'>[] = [
      { text: style(`  ${prompt} [`) },
      { text: style('y'), value: 'confirm' },
      { text: style('/') },
      { text: style('N'), value: 'cancel' },
      { text: style(']') },
    ];
    const rendered = renderInlineSegments(segments, width);
    this.confirmHits.addRow(row, rendered.targets);
    return rendered.line;
  }
}


function renderRow(
  row: Row,
  ctx: { isSelected: boolean; width: number },
): string[] {
  const { isSelected, width } = ctx;
  const pointer = isSelected ? SELECT_POINTER : ' ';
  const pointerStyle = (text: string) =>
    isSelected ? currentTheme.fg('primary', text) : currentTheme.fg('textDim', text);
  const labelStyle = (text: string) =>
    isSelected
      ? currentTheme.boldFg('primary', text)
      : row.kind === 'add'
        ? currentTheme.fg('primary', text)
        : currentTheme.fg('text', text);

  const isActive = row.kind === 'source' && row.hasActive;
  const marker = isActive ? ` ${CURRENT_MARK}` : '';

  const labelWidth = Math.max(0, width - 4 - visibleWidth(marker));
  const labelText = truncateToWidth(row.label, labelWidth, '…');
  let line = `  ${pointerStyle(`${pointer} `)}${labelStyle(labelText)}`;
  if (isActive) line += currentTheme.fg('success', marker);

  const lines: string[] = [line];

  if (row.kind === 'source' && row.baseUrl !== undefined && row.baseUrl.length > 0) {
    const urlText = truncateToWidth(row.baseUrl, Math.max(0, width - 6), '…');
    lines.push(currentTheme.fg('textMuted', `      ${urlText}`));
  }

  return lines;
}
