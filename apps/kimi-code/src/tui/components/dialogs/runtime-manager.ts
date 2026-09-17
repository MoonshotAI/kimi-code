/**
 * RuntimeManagerComponent — pure-view management UI for the `/runtime` command
 * (experimental remote runtime), modeled on `provider-manager.ts`.
 *
 * One row per registered runtime (local first) plus a synthetic
 * `[ Add Runtime ]` action row. Each runtime row shows its id, the bound
 * runtime's `← current` marker, and a secondary line with type, connection
 * status, the disconnect reason while disconnected, and the declaration's
 * defaultCwd. A disconnected bound row offers
 * an explicit reconnect on `R`; switch and reconnect failures surface inline
 * (exit code and bounded stderr ride the engine's error message).
 *
 * Keyboard:
 *   - ↑ / ↓             move highlight
 *   - ← / → · PgUp/PgDn page
 *   - Enter             switch to the highlighted runtime (no-op on the
 *                       current one); on `[ Add Runtime ]` → `onAdd()`
 *   - R                 reconnect the bound runtime (only while the
 *                       highlighted row is the bound one and disconnected)
 *   - Esc               clear an inline error first, then `onClose()`
 *
 * The component is pure-view: every SDK side effect is dispatched back
 * through callbacks; the host reports progress via `setBusy` / `showError`.
 */

import type { SessionRuntimeStatus, SessionRuntimeType } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { pageView, type PageView } from '#/tui/utils/paging';

export interface RuntimeManagerRuntime {
  readonly runtimeId: string;
  readonly type: SessionRuntimeType;
  readonly status: SessionRuntimeStatus;
  readonly defaultCwd?: string;
  readonly connectError?: string;
}

export interface RuntimeManagerOptions {
  readonly runtimes: readonly RuntimeManagerRuntime[];
  readonly currentRuntimeId: string;
  readonly onSwitch: (runtimeId: string) => void;
  readonly onReconnect: (runtimeId: string) => void;
  readonly onAdd: () => void;
  readonly onClose: () => void;
}

interface RuntimeRow {
  readonly kind: 'runtime';
  readonly runtime: RuntimeManagerRuntime;
}

interface AddRow {
  readonly kind: 'add';
}

type Row = RuntimeRow | AddRow;

type ActionState =
  | { readonly kind: 'busy'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
  | undefined;

const ADD_ROW_LABEL = '[ Add Runtime ]';
const PAGE_SIZE = 8;
const MAX_ERROR_LINES = 4;

function buildRows(runtimes: readonly RuntimeManagerRuntime[]): readonly Row[] {
  const sorted = runtimes.toSorted(
    (a, b) => Number(b.runtimeId === 'local') - Number(a.runtimeId === 'local'),
  );
  return [...sorted.map((runtime) => ({ kind: 'runtime' as const, runtime })), { kind: 'add' }];
}

export class RuntimeManagerComponent extends Container implements Focusable {
  focused = false;
  private opts: RuntimeManagerOptions;
  private rows: readonly Row[];
  private selectedIndex: number;
  private action: ActionState;

  constructor(opts: RuntimeManagerOptions) {
    super();
    this.opts = opts;
    this.rows = buildRows(opts.runtimes);
    const currentIdx = this.rows.findIndex(
      (row) => row.kind === 'runtime' && row.runtime.runtimeId === opts.currentRuntimeId,
    );
    this.selectedIndex = Math.max(currentIdx, 0);
    this.action = undefined;
  }

  /** Replace the rendered snapshot (e.g. refreshed statuses after a reconnect). */
  setOptions(next: RuntimeManagerOptions): void {
    const previousSelected = this.rows[this.selectedIndex];
    const previousId = previousSelected?.kind === 'runtime' ? previousSelected.runtime.runtimeId : undefined;
    this.opts = next;
    this.rows = buildRows(next.runtimes);
    this.action = undefined;
    let newIdx = -1;
    if (previousId !== undefined) {
      newIdx = this.rows.findIndex(
        (row) => row.kind === 'runtime' && row.runtime.runtimeId === previousId,
      );
    }
    if (newIdx < 0) newIdx = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
    this.selectedIndex = newIdx;
    this.invalidate();
  }

  /** Lock the dialog while a connect / reconnect is in flight. */
  setBusy(message: string): void {
    this.action = { kind: 'busy', message };
    this.invalidate();
  }

  /** Show a failure inline (handshake exit code + bounded stderr, cwd validation). */
  showError(message: string): void {
    this.action = { kind: 'error', message };
    this.invalidate();
  }

  clearAction(): void {
    this.action = undefined;
    this.invalidate();
  }

  private page(): PageView {
    return pageView(this.rows.length, this.selectedIndex, PAGE_SIZE);
  }

  /** The highlighted row is the bound runtime, remote, and disconnected. */
  private reconnectableSelected(): boolean {
    const selected = this.rows[this.selectedIndex];
    return (
      selected?.kind === 'runtime' &&
      selected.runtime.runtimeId === this.opts.currentRuntimeId &&
      selected.runtime.runtimeId !== 'local' &&
      selected.runtime.status === 'disconnected'
    );
  }

  handleInput(data: string): void {
    if (this.action?.kind === 'busy') return;

    if (matchesKey(data, Key.escape)) {
      if (this.action?.kind === 'error') {
        this.clearAction();
        return;
      }
      this.opts.onClose();
      return;
    }
    if (this.action?.kind === 'error') this.clearAction();

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
      if (selected === undefined) return;
      if (selected.kind === 'add') {
        this.opts.onAdd();
        return;
      }
      if (selected.runtime.runtimeId !== this.opts.currentRuntimeId) {
        this.opts.onSwitch(selected.runtime.runtimeId);
      }
      return;
    }

    const ch = printableChar(data);
    if ((ch === 'r' || ch === 'R') && this.reconnectableSelected()) {
      this.opts.onReconnect(this.opts.currentRuntimeId);
    }
  }

  override render(width: number): string[] {
    const lines: string[] = [];

    // Header shape mirrors the provider manager (one top border, title, hint,
    // blank line — no inner border under the title).
    const border = currentTheme.fg('primary', '─'.repeat(width));
    lines.push(border);
    lines.push(currentTheme.boldFg('primary', ' Runtimes'));
    const hint = this.reconnectableSelected()
      ? ' ↑↓ navigate · Enter switch · R reconnect · Esc cancel'
      : ' ↑↓ navigate · Enter switch · Esc cancel';
    lines.push(currentTheme.fg('textMuted', hint));
    lines.push('');

    const view = this.page();
    for (let i = view.start; i < view.end; i++) {
      const row = this.rows[i];
      if (row === undefined) continue;
      for (const line of renderRow(row, {
        isSelected: i === this.selectedIndex,
        isCurrent: row.kind === 'runtime' && row.runtime.runtimeId === this.opts.currentRuntimeId,
        width,
      })) {
        lines.push(line);
      }
    }

    lines.push('');

    if (this.action?.kind === 'busy') {
      lines.push(currentTheme.fg('textMuted', ` ${this.action.message}`));
    } else if (this.action?.kind === 'error') {
      for (const line of this.action.message.split('\n').slice(0, MAX_ERROR_LINES)) {
        lines.push(currentTheme.fg('error', ` ${line}`));
      }
    } else if (view.pageCount > 1) {
      lines.push(
        currentTheme.fg('textMuted', ` Page ${String(view.page + 1)}/${String(view.pageCount)}`),
      );
    }

    lines.push(border);
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function renderRow(
  row: Row,
  ctx: { isSelected: boolean; isCurrent: boolean; width: number },
): string[] {
  const { isSelected, isCurrent, width } = ctx;
  const pointer = isSelected ? SELECT_POINTER : ' ';
  const pointerStyle = (text: string) =>
    isSelected ? currentTheme.fg('primary', text) : currentTheme.fg('textDim', text);
  const labelStyle = (text: string) =>
    isSelected
      ? currentTheme.boldFg('primary', text)
      : row.kind === 'add'
        ? currentTheme.fg('primary', text)
        : currentTheme.fg('text', text);

  const label = row.kind === 'add' ? ADD_ROW_LABEL : row.runtime.runtimeId;
  const marker = isCurrent ? ` ${CURRENT_MARK}` : '';
  const labelWidth = Math.max(0, width - 4 - visibleWidth(marker));
  const labelText = truncateToWidth(label, labelWidth, '…');
  let line = `  ${pointerStyle(`${pointer} `)}${labelStyle(labelText)}`;
  if (isCurrent) line += currentTheme.fg('success', marker);

  const lines: string[] = [line];

  if (row.kind === 'runtime') {
    lines.push(renderSecondary(row.runtime, width));
  }

  return lines;
}

function renderSecondary(runtime: RuntimeManagerRuntime, width: number): string {
  if (runtime.runtimeId === 'local') {
    return currentTheme.fg('textMuted', '      this machine');
  }
  const statusStyle = (text: string) =>
    runtime.status === 'ready'
      ? currentTheme.fg('success', text)
      : runtime.status === 'disconnected'
        ? currentTheme.fg('error', text)
        : currentTheme.fg('textDim', text);
  let line = currentTheme.fg('textMuted', `      ${runtime.type} · `) + statusStyle(runtime.status);
  if (runtime.status === 'disconnected' && runtime.connectError !== undefined) {
    line += currentTheme.fg('error', ` · ${runtime.connectError.split('\n', 1)[0]}`);
  }
  if (runtime.defaultCwd !== undefined && runtime.defaultCwd.length > 0) {
    line += currentTheme.fg('textMuted', ` · ${runtime.defaultCwd}`);
  }
  return truncateToWidth(line, Math.max(0, width), '…');
}
