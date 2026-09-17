/**
 * EnvironmentManagerComponent — pure-view management UI for the `/environment` command
 * (experimental remote environment), modeled on `provider-manager.ts`.
 *
 * One row per registered environment (local first) plus a synthetic
 * `[ Add Environment ]` action row. Each environment row shows its id, the bound
 * environment's `← current` marker, and a secondary line with type, connection
 * status, the disconnect reason while disconnected, and the declaration's
 * defaultCwd. A disconnected bound row offers
 * an explicit reconnect on `R`; switch and reconnect failures surface inline
 * (exit code and bounded stderr ride the engine's error message).
 *
 * Keyboard:
 *   - ↑ / ↓             move highlight
 *   - ← / → · PgUp/PgDn page
 *   - Enter             switch to the highlighted environment (no-op on the
 *                       current one); on `[ Add Environment ]` → `onAdd()`
 *   - R                 reconnect the bound environment (only while the
 *                       highlighted row is the bound one and disconnected)
 *   - Esc               clear an inline error first, then `onClose()`
 *
 * The component is pure-view: every SDK side effect is dispatched back
 * through callbacks; the host reports progress via `setBusy` / `showError`.
 */

import type { SessionEnvironmentStatus, SessionEnvironmentType } from '@moonshot-ai/kimi-code-sdk';
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

export interface EnvironmentManagerEnvironment {
  readonly environmentId: string;
  readonly type: SessionEnvironmentType;
  readonly status: SessionEnvironmentStatus;
  readonly defaultCwd?: string;
  readonly connectError?: string;
}

export interface EnvironmentManagerOptions {
  readonly environments: readonly EnvironmentManagerEnvironment[];
  readonly currentEnvironmentId: string;
  readonly onSwitch: (environmentId: string) => void;
  readonly onReconnect: (environmentId: string) => void;
  readonly onAdd: () => void;
  readonly onClose: () => void;
}

interface EnvironmentRow {
  readonly kind: 'environment';
  readonly environment: EnvironmentManagerEnvironment;
}

interface AddRow {
  readonly kind: 'add';
}

type Row = EnvironmentRow | AddRow;

type ActionState =
  | { readonly kind: 'busy'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
  | undefined;

const ADD_ROW_LABEL = '[ Add Environment ]';
const PAGE_SIZE = 8;
const MAX_ERROR_LINES = 4;

function buildRows(environments: readonly EnvironmentManagerEnvironment[]): readonly Row[] {
  const sorted = environments.toSorted(
    (a, b) => Number(b.environmentId === 'local') - Number(a.environmentId === 'local'),
  );
  return [...sorted.map((environment) => ({ kind: 'environment' as const, environment })), { kind: 'add' }];
}

export class EnvironmentManagerComponent extends Container implements Focusable {
  focused = false;
  private opts: EnvironmentManagerOptions;
  private rows: readonly Row[];
  private selectedIndex: number;
  private action: ActionState;

  constructor(opts: EnvironmentManagerOptions) {
    super();
    this.opts = opts;
    this.rows = buildRows(opts.environments);
    const currentIdx = this.rows.findIndex(
      (row) => row.kind === 'environment' && row.environment.environmentId === opts.currentEnvironmentId,
    );
    this.selectedIndex = Math.max(currentIdx, 0);
    this.action = undefined;
  }

  /** Replace the rendered snapshot (e.g. refreshed statuses after a reconnect). */
  setOptions(next: EnvironmentManagerOptions): void {
    const previousSelected = this.rows[this.selectedIndex];
    const previousId = previousSelected?.kind === 'environment' ? previousSelected.environment.environmentId : undefined;
    this.opts = next;
    this.rows = buildRows(next.environments);
    this.action = undefined;
    let newIdx = -1;
    if (previousId !== undefined) {
      newIdx = this.rows.findIndex(
        (row) => row.kind === 'environment' && row.environment.environmentId === previousId,
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

  /** The highlighted row is the bound environment, remote, and disconnected. */
  private reconnectableSelected(): boolean {
    const selected = this.rows[this.selectedIndex];
    return (
      selected?.kind === 'environment' &&
      selected.environment.environmentId === this.opts.currentEnvironmentId &&
      selected.environment.environmentId !== 'local' &&
      selected.environment.status === 'disconnected'
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
      if (selected.environment.environmentId !== this.opts.currentEnvironmentId) {
        this.opts.onSwitch(selected.environment.environmentId);
      }
      return;
    }

    const ch = printableChar(data);
    if ((ch === 'r' || ch === 'R') && this.reconnectableSelected()) {
      this.opts.onReconnect(this.opts.currentEnvironmentId);
    }
  }

  override render(width: number): string[] {
    const lines: string[] = [];

    // Header shape mirrors the provider manager (one top border, title, hint,
    // blank line — no inner border under the title).
    const border = currentTheme.fg('primary', '─'.repeat(width));
    lines.push(border);
    lines.push(currentTheme.boldFg('primary', ' Environments'));
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
        isCurrent: row.kind === 'environment' && row.environment.environmentId === this.opts.currentEnvironmentId,
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

  const label = row.kind === 'add' ? ADD_ROW_LABEL : row.environment.environmentId;
  const marker = isCurrent ? ` ${CURRENT_MARK}` : '';
  const labelWidth = Math.max(0, width - 4 - visibleWidth(marker));
  const labelText = truncateToWidth(label, labelWidth, '…');
  let line = `  ${pointerStyle(`${pointer} `)}${labelStyle(labelText)}`;
  if (isCurrent) line += currentTheme.fg('success', marker);

  const lines: string[] = [line];

  if (row.kind === 'environment') {
    lines.push(renderSecondary(row.environment, width));
  }

  return lines;
}

function renderSecondary(environment: EnvironmentManagerEnvironment, width: number): string {
  if (environment.environmentId === 'local') {
    return currentTheme.fg('textMuted', '      this machine');
  }
  const statusStyle = (text: string) =>
    environment.status === 'ready'
      ? currentTheme.fg('success', text)
      : environment.status === 'disconnected'
        ? currentTheme.fg('error', text)
        : currentTheme.fg('textDim', text);
  let line = currentTheme.fg('textMuted', `      ${environment.type} · `) + statusStyle(environment.status);
  if (environment.status === 'disconnected' && environment.connectError !== undefined) {
    line += currentTheme.fg('error', ` · ${environment.connectError.split('\n', 1)[0]}`);
  }
  if (environment.defaultCwd !== undefined && environment.defaultCwd.length > 0) {
    line += currentTheme.fg('textMuted', ` · ${environment.defaultCwd}`);
  }
  return truncateToWidth(line, Math.max(0, width), '…');
}
