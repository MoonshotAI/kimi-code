import { CODE_TIP_ATTR } from './codeTooltip';

export const TABLE_CELL_SELECTED_CLASS = 'md-table-cell-selected';

export type TableCopyFormat = 'tsv' | 'markdown' | 'csv' | 'json';
type SelectionKind = 'all' | 'cell' | 'column';

export interface TableSelectionLabels {
  selectColumn: string;
}

interface Point {
  row: number;
  column: number;
}

interface PointerSelection {
  kind: Exclude<SelectionKind, 'all'>;
  anchor: Point;
  x: number;
  y: number;
  moved: boolean;
  textSelection: boolean;
}

interface TableSelectionState {
  wrapper: HTMLElement;
  home: HTMLElement;
  labels: TableSelectionLabels;
  selected: Set<string>;
  anchor: Point;
  active: Point;
  pointer: PointerSelection | null;
  cleanups: Array<() => void>;
}

const states = new Map<HTMLElement, TableSelectionState>();
const pointKey = (point: Point): string => `${point.row}:${point.column}`;
const parsePoint = (key: string): Point => {
  const [row, column] = key.split(':').map(Number);
  return { row: row ?? 0, column: column ?? 0 };
};
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

function tableFor(wrapper: HTMLElement): HTMLTableElement | null {
  return wrapper.querySelector<HTMLTableElement>('table');
}

function rowsFor(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.querySelectorAll<HTMLTableRowElement>('thead > tr, tbody > tr'));
}

function cellsFor(table: HTMLTableElement): HTMLTableCellElement[][] {
  return rowsFor(table).map(row => Array.from(row.querySelectorAll<HTMLTableCellElement>(':scope > [data-md-table-cell]')));
}

function dimensions(table: HTMLTableElement): { rows: number; columns: number } {
  const rows = cellsFor(table);
  return { rows: rows.length, columns: Math.max(0, ...rows.map(row => row.length)) };
}

function textFor(cell: HTMLTableCellElement): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') {
      parts.push('\n');
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(cell);
  return parts.join('').replace(/\r\n/g, '\n').split('\n').map(part => part.replace(/\s+/g, ' ').trim()).join('\n').trim();
}

function selectedMatrix(table: HTMLTableElement, selected: Set<string>): string[][] {
  const cells = cellsFor(table);
  const points = [...selected].map(parsePoint);
  const rowIndexes = [...new Set(points.map(point => point.row))].sort((a, b) => a - b);
  const columnIndexes = [...new Set(points.map(point => point.column))].sort((a, b) => a - b);
  return rowIndexes.map(row => columnIndexes.map(column => {
    const cell = cells[row]?.[column];
    return cell && selected.has(pointKey({ row, column })) ? textFor(cell) : '';
  }));
}

function selectedColumns(table: HTMLTableElement, selected: Set<string>): number[] {
  return [...new Set([...selected].map(key => parsePoint(key).column))].sort((a, b) => a - b);
}

function originalHeaders(table: HTMLTableElement, columns: number[]): string[] {
  const cells = cellsFor(table);
  return columns.map(column => {
    const header = cells[0]?.[column];
    return header ? textFor(header) : `Column ${column + 1}`;
  });
}

function uniqueJsonKeys(headers: string[]): string[] {
  const used = new Set<string>();
  return headers.map((header, index) => {
    const base = header === '' ? `Column ${index + 1}` : header;
    let key = base;
    let suffix = 2;
    while (used.has(key)) {
      key = `${base} (${suffix})`;
      suffix += 1;
    }
    used.add(key);
    return key;
  });
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function markdownCell(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\r?\n/g, '<br>');
}

export function serializeTableSelection(table: HTMLTableElement, selected: Set<string>, format: TableCopyFormat): string {
  if (selected.size === 0) return '';
  const matrix = selectedMatrix(table, selected);
  if (format === 'tsv') return matrix.map(row => row.join('\t')).join('\n');
  if (format === 'csv') return matrix.map(row => row.map(csvCell).join(',')).join('\n');
  const points = [...selected].map(parsePoint);
  const columns = selectedColumns(table, selected);
  if (format === 'markdown') {
    const hasHeader = points.some(point => point.row === 0);
    const header = hasHeader ? matrix[0] ?? [] : originalHeaders(table, columns);
    const body = hasHeader ? matrix.slice(1) : matrix;
    return [
      `| ${header.map(markdownCell).join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...body.map(row => `| ${row.map(markdownCell).join(' | ')} |`),
    ].join('\n');
  }
  const headers = uniqueJsonKeys(originalHeaders(table, columns));
  const cells = cellsFor(table);
  const rows = [...new Set(points.map(point => point.row))].filter(row => row > 0).sort((a, b) => a - b);
  return JSON.stringify(rows.map(row => Object.fromEntries(columns.map((column, index) => {
    const key = headers[index] ?? `Column ${column + 1}`;
    const cell = cells[row]?.[column];
    return [key, cell && selected.has(pointKey({ row, column })) ? textFor(cell) : ''];
  }))), null, 2);
}

function selectionHtml(table: HTMLTableElement, selected: Set<string>): string {
  const matrix = selectedMatrix(table, selected);
  const includesHeader = [...selected].some(key => parsePoint(key).row === 0);
  return `<table><tbody>${matrix.map((row, rowIndex) => `<tr>${row.map(value => {
    const tag = includesHeader && rowIndex === 0 ? 'th' : 'td';
    const text = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
    return `<${tag}>${text}</${tag}>`;
  }).join('')}</tr>`).join('')}</tbody></table>`;
}

function fullSelection(table: HTMLTableElement, kind: SelectionKind, start: Point, end = start): Set<string> {
  const { rows, columns } = dimensions(table);
  const selected = new Set<string>();
  if (kind === 'all') {
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) selected.add(pointKey({ row, column }));
    return selected;
  }
  if (kind === 'column') {
    const from = Math.min(start.column, end.column);
    const to = Math.max(start.column, end.column);
    for (let row = 0; row < rows; row++) for (let column = from; column <= to; column++) selected.add(pointKey({ row, column }));
    return selected;
  }
  const rowFrom = Math.min(start.row, end.row);
  const rowTo = Math.max(start.row, end.row);
  const columnFrom = Math.min(start.column, end.column);
  const columnTo = Math.max(start.column, end.column);
  for (let row = rowFrom; row <= rowTo; row++) {
    for (let column = columnFrom; column <= columnTo; column++) selected.add(pointKey({ row, column }));
  }
  return selected;
}

export function selectEntireTable(wrapper: HTMLElement): boolean {
  const state = states.get(wrapper);
  const table = tableFor(wrapper);
  if (!state || !table) return false;
  setSelection(state, fullSelection(table, 'all', { row: 0, column: 0 }), { row: 0, column: 0 });
  return true;
}

export function tableSelectionText(wrapper: HTMLElement, format: TableCopyFormat = 'tsv'): string | null {
  const state = states.get(wrapper);
  const table = tableFor(wrapper);
  if (!state || !table || state.selected.size === 0) return null;
  return serializeTableSelection(table, state.selected, format);
}

export function tableSelectionContextText(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const wrapper = target.closest<HTMLElement>('.table-node-wrapper');
  return wrapper ? tableSelectionText(wrapper) : null;
}

function syncVisualState(state: TableSelectionState): void {
  const table = tableFor(state.wrapper);
  if (!table) return;
  const cells = cellsFor(table);
  cells.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
    const key = pointKey({ row: rowIndex, column: columnIndex });
    cell.classList.toggle(TABLE_CELL_SELECTED_CLASS, state.selected.has(key));
    cell.setAttribute('aria-selected', String(state.selected.has(key)));
  }));
  rowsFor(table).forEach((row, rowIndex) => {
    row.classList.toggle('md-table-row-selected', cells[rowIndex]?.every((cell, columnIndex) => state.selected.has(pointKey({ row: rowIndex, column: columnIndex }))) ?? false);
  });
  state.wrapper.classList.toggle('md-table-has-selection', state.selected.size > 0);
}

function setSelection(state: TableSelectionState, next: Set<string>, anchor: Point, active = anchor): void {
  state.selected = next;
  state.anchor = anchor;
  state.active = active;
  syncVisualState(state);
}

function clearSelection(state: TableSelectionState): void {
  state.selected.clear();
  state.pointer = null;
  state.wrapper.classList.remove('md-table-selecting');
  syncVisualState(state);
}

function syncStructure(state: TableSelectionState): void {
  const table = tableFor(state.wrapper);
  if (!table) return;
  state.wrapper.tabIndex = 0;
  rowsFor(table).forEach((row, rowIndex) => {
    const cells = Array.from(row.children).filter((child): child is HTMLTableCellElement => child instanceof HTMLTableCellElement);
    cells.forEach((cell, columnIndex) => {
      cell.setAttribute('data-md-table-cell', '');
      cell.dataset.mdTableRow = String(rowIndex);
      cell.dataset.mdTableColumn = String(columnIndex);
      cell.setAttribute('aria-selected', 'false');
      if (rowIndex === 0) {
        cell.setAttribute(CODE_TIP_ATTR, state.labels.selectColumn);
        cell.setAttribute('aria-label', `${textFor(cell)}，${state.labels.selectColumn}`);
      }
    });
  });
}

function pointFromCell(cell: Element | null, wrapper?: HTMLElement): Point | null {
  if (!(cell instanceof HTMLTableCellElement) || !cell.hasAttribute('data-md-table-cell')) return null;
  if (wrapper !== undefined && cell.closest('.table-node-wrapper') !== wrapper) return null;
  const row = Number(cell.dataset.mdTableRow);
  const column = Number(cell.dataset.mdTableColumn);
  return Number.isInteger(row) && Number.isInteger(column) ? { row, column } : null;
}

function eventCell(event: Event): HTMLTableCellElement | null {
  const target = event.target;
  return target instanceof Element ? target.closest<HTMLTableCellElement>('[data-md-table-cell]') : null;
}

function eventPoint(state: TableSelectionState, event: PointerEvent): Point | null {
  const target = event.target instanceof Element ? event.target : null;
  const direct = pointFromCell(target?.closest('[data-md-table-cell]') ?? null, state.wrapper);
  if (direct) return direct;
  const element = state.wrapper.ownerDocument.elementFromPoint?.(event.clientX, event.clientY);
  return pointFromCell(element?.closest('[data-md-table-cell]') ?? null, state.wrapper);
}

function applyPointerSelection(state: TableSelectionState, end: Point): void {
  const pointer = state.pointer;
  const table = tableFor(state.wrapper);
  if (!pointer || !table) return;
  const { rows, columns } = dimensions(table);
  const clamped = {
    row: clamp(end.row, 0, Math.max(0, rows - 1)),
    column: clamp(end.column, 0, Math.max(0, columns - 1)),
  };
  setSelection(state, fullSelection(table, pointer.kind, pointer.anchor, clamped), pointer.anchor, clamped);
}

function onPointerDown(state: TableSelectionState, event: PointerEvent): void {
  if (event.button !== 0) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('a, button, input, select, textarea')) return;
  const point = pointFromCell(eventCell(event), state.wrapper);
  if (!point) return;
  const kind: PointerSelection['kind'] = point.row === 0 ? 'column' : 'cell';
  if (!event.shiftKey && state.selected.size > 0) clearSelection(state);
  const anchor = event.shiftKey ? state.anchor : point;
  state.anchor = anchor;
  state.pointer = { kind, anchor, x: event.clientX, y: event.clientY, moved: false, textSelection: false };
  if (event.shiftKey) event.preventDefault();
}

function onPointerMove(state: TableSelectionState, event: PointerEvent): void {
  const pointer = state.pointer;
  if (!pointer) return;
  if (!pointer.moved && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 5) return;
  const point = eventPoint(state, event);
  if (!point) return;
  if (!pointer.moved && point.row === pointer.anchor.row && point.column === pointer.anchor.column) {
    pointer.textSelection = true;
    return;
  }
  pointer.moved = true;
  event.preventDefault();
  state.wrapper.classList.add('md-table-selecting');
  state.wrapper.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
  applyPointerSelection(state, point);
}

function onPointerUp(state: TableSelectionState, event: PointerEvent): void {
  const pointer = state.pointer;
  if (!pointer) return;
  if (pointer.textSelection && !pointer.moved) {
    state.pointer = null;
    return;
  }
  if (!pointer.moved && pointer.kind === 'cell' && !event.shiftKey) {
    state.pointer = null;
    return;
  }
  const point = eventPoint(state, event) ?? (pointer.moved ? state.active : pointer.anchor);
  applyPointerSelection(state, point);
  state.pointer = null;
  state.wrapper.classList.remove('md-table-selecting');
  state.wrapper.focus({ preventScroll: true });
}

function onKeyDown(state: TableSelectionState, event: KeyboardEvent): void {
  const table = tableFor(state.wrapper);
  if (!table) return;
  if (event.key === 'Escape') {
    clearSelection(state);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    setSelection(state, fullSelection(table, 'all', { row: 0, column: 0 }), { row: 0, column: 0 });
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  if (state.selected.size === 0 && state.wrapper.ownerDocument.defaultView?.getSelection()?.isCollapsed === false) return;
  event.preventDefault();
  const { rows, columns } = dimensions(table);
  if (rows === 0 || columns === 0) return;
  const delta = {
    ArrowUp: { row: -1, column: 0 }, ArrowDown: { row: 1, column: 0 },
    ArrowLeft: { row: 0, column: -1 }, ArrowRight: { row: 0, column: 1 },
  }[event.key]!;
  const active = state.selected.size === 0 ? { row: 0, column: 0 } : {
    row: clamp(state.active.row + delta.row, 0, rows - 1),
    column: clamp(state.active.column + delta.column, 0, columns - 1),
  };
  const anchor = event.shiftKey && state.selected.size > 0 ? state.anchor : active;
  setSelection(state, fullSelection(table, 'cell', anchor, active), anchor, active);
}

function onCopy(state: TableSelectionState, event: ClipboardEvent): void {
  const table = tableFor(state.wrapper);
  if (!table || state.selected.size === 0 || !event.clipboardData) return;
  event.preventDefault();
  event.clipboardData.setData('text/plain', serializeTableSelection(table, state.selected, 'tsv'));
  event.clipboardData.setData('text/html', selectionHtml(table, state.selected));
}

export function ensureTableSelection(wrapper: HTMLElement, labels: TableSelectionLabels): void {
  const existing = states.get(wrapper);
  if (existing) {
    existing.labels = labels;
    syncStructure(existing);
    syncVisualState(existing);
    return;
  }
  if (!tableFor(wrapper)) return;
  const state: TableSelectionState = {
    wrapper, home: wrapper.closest<HTMLElement>('.md') ?? wrapper.parentElement ?? wrapper,
    labels, selected: new Set(), anchor: { row: 0, column: 0 }, active: { row: 0, column: 0 },
    pointer: null, cleanups: [],
  };
  states.set(wrapper, state);
  const doc = wrapper.ownerDocument;
  const listen = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void): void => {
    target.addEventListener(type, handler as EventListener);
    state.cleanups.push(() => target.removeEventListener(type, handler as EventListener));
  };
  listen(wrapper, 'pointerdown', event => onPointerDown(state, event));
  listen(wrapper, 'keydown', event => onKeyDown(state, event));
  listen(wrapper, 'copy', event => onCopy(state, event));
  const move = (event: PointerEvent): void => onPointerMove(state, event);
  const up = (event: PointerEvent): void => onPointerUp(state, event);
  const outside = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node) || wrapper.contains(target)) return;
    if (target instanceof Element && target.closest('.table-selection-context-menu, .table-selection-copy-submenu')) return;
    const actions = target instanceof Element ? target.closest('.md-table-actions') : null;
    if (actions?.parentElement === wrapper.parentElement) return;
    clearSelection(state);
  };
  doc.addEventListener('pointermove', move);
  doc.addEventListener('pointerup', up);
  doc.addEventListener('pointerdown', outside);
  state.cleanups.push(
    () => doc.removeEventListener('pointermove', move),
    () => doc.removeEventListener('pointerup', up),
    () => doc.removeEventListener('pointerdown', outside),
  );
  syncStructure(state);
}

function destroyState(state: TableSelectionState): void {
  state.cleanups.forEach(cleanup => cleanup());
  const table = tableFor(state.wrapper);
  if (table) {
    for (const cell of table.querySelectorAll<HTMLElement>('[data-md-table-cell]')) {
      cell.classList.remove(TABLE_CELL_SELECTED_CLASS);
      cell.removeAttribute('aria-selected');
      cell.removeAttribute('data-md-table-cell');
      cell.removeAttribute('data-md-table-row');
      cell.removeAttribute('data-md-table-column');
      cell.removeAttribute(CODE_TIP_ATTR);
      if (cell.tagName === 'TH') cell.removeAttribute('aria-label');
    }
  }
  state.wrapper.classList.remove('md-table-selecting', 'md-table-has-selection');
  state.wrapper.removeAttribute('tabindex');
  states.delete(state.wrapper);
}

export function pruneTableSelections(root: HTMLElement): void {
  for (const [wrapper, state] of states) {
    if (state.home === root && !root.contains(wrapper)) destroyState(state);
  }
}

export function destroyTableSelections(root: HTMLElement): void {
  for (const state of states.values()) if (state.home === root || root.contains(state.wrapper)) destroyState(state);
}
