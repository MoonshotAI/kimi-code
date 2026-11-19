// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markdownTableSources } from './tableSource';
import {
  destroyTableSelections,
  ensureTableSelection,
  pruneTableSelections,
  serializeTableSelection,
  selectEntireTable,
  tableSelectionContextText,
  tableSelectionText,
  TABLE_CELL_SELECTED_CLASS,
  type TableSelectionLabels,
} from './tableSelection';

const LABELS: TableSelectionLabels = { selectColumn: 'Select column' };

let root: HTMLElement;
let wrapper: HTMLElement;
let table: HTMLTableElement;

function pointer(target: Element, type: string, options: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...options });
  target.dispatchEvent(event);
  return event;
}

function cells(): HTMLTableCellElement[][] {
  return Array.from(table.querySelectorAll<HTMLTableRowElement>('thead > tr, tbody > tr')).map(row =>
    Array.from(row.querySelectorAll<HTMLTableCellElement>(':scope > [data-md-table-cell]')),
  );
}

function selectedKeys(): Set<string> {
  return new Set(cells().flatMap((row, rowIndex) => row.flatMap((cell, columnIndex) =>
    cell.classList.contains(TABLE_CELL_SELECTED_CLASS) ? [`${rowIndex}:${columnIndex}`] : [],
  )));
}

beforeEach(() => {
  root = document.createElement('div');
  root.className = 'md';
  wrapper = document.createElement('div');
  wrapper.className = 'table-node-wrapper';
  wrapper.innerHTML = '<table><thead><tr><th>Name</th><th>Department</th><th>Note</th></tr></thead><tbody><tr><td>Alice</td><td>Product</td><td>a,b</td></tr><tr><td>Bob</td><td>R&amp;D</td><td>x|y</td></tr><tr><td>Carol</td><td>Design</td><td>plain</td></tr></tbody></table>';
  root.appendChild(wrapper);
  document.body.appendChild(root);
  table = wrapper.querySelector('table')!;
  ensureTableSelection(wrapper, LABELS);
});

afterEach(() => {
  destroyTableSelections(root);
  root.remove();
  vi.restoreAllMocks();
});

describe('table selection interactions', () => {
  it('keeps the original table without any added controls or columns', () => {
    expect(wrapper.querySelector('button')).toBeNull();
    expect(wrapper.querySelectorAll('thead th')).toHaveLength(3);
    for (const row of wrapper.querySelectorAll('tbody tr')) expect(row.children).toHaveLength(3);
    ensureTableSelection(wrapper, LABELS);
    expect(wrapper.querySelector('button')).toBeNull();
  });

  it('selects a whole column from its header and extends columns with Shift', () => {
    const grid = cells();
    pointer(grid[0]![1]!, 'pointerdown');
    pointer(grid[0]![1]!, 'pointerup');
    expect(selectedKeys()).toEqual(new Set(['0:1', '1:1', '2:1', '3:1']));
    expect(wrapper.classList.contains('md-table-has-selection')).toBe(true);
    pointer(grid[0]![2]!, 'pointerdown', { shiftKey: true });
    pointer(grid[0]![2]!, 'pointerup', { shiftKey: true });
    expect(selectedKeys().size).toBe(8);
    expect(serializeTableSelection(table, selectedKeys(), 'tsv')).toBe('Department\tNote\nProduct\ta,b\nR&D\tx|y\nDesign\tplain');
  });

  it('selects the entire table through the context-menu API', () => {
    const grid = cells();
    pointer(grid[1]![0]!, 'pointerdown');
    pointer(grid[2]![1]!, 'pointermove', { clientX: 50, clientY: 50 });
    pointer(grid[2]![1]!, 'pointerup', { clientX: 50, clientY: 50 });
    expect(selectedKeys().size).toBe(4);
    expect(selectEntireTable(wrapper)).toBe(true);
    expect(selectedKeys().size).toBe(12);
    expect(tableSelectionText(wrapper, 'tsv')).toBe('Name\tDepartment\tNote\nAlice\tProduct\ta,b\nBob\tR&D\tx|y\nCarol\tDesign\tplain');
    expect(selectEntireTable(document.createElement('div'))).toBe(false);
  });

  it('selects a row by dragging across its cells without a row handle', () => {
    const grid = cells();
    pointer(grid[2]![0]!, 'pointerdown', { clientX: 10, clientY: 10 });
    pointer(grid[2]![2]!, 'pointermove', { clientX: 100, clientY: 10 });
    pointer(grid[2]![2]!, 'pointerup', { clientX: 100, clientY: 10 });
    expect(selectedKeys()).toEqual(new Set(['2:0', '2:1', '2:2']));
  });

  it('drags a rectangular cell range and clears it by clicking elsewhere', () => {
    const grid = cells();
    pointer(grid[1]![0]!, 'pointerdown', { clientX: 10, clientY: 10 });
    pointer(grid[2]![1]!, 'pointermove', { clientX: 60, clientY: 60 });
    pointer(grid[2]![1]!, 'pointerup', { clientX: 60, clientY: 60 });
    expect(selectedKeys()).toEqual(new Set(['1:0', '1:1', '2:0', '2:1']));
    expect(serializeTableSelection(table, selectedKeys(), 'tsv')).toBe('Alice\tProduct\nBob\tR&D');
    pointer(document.body, 'pointerdown');
    expect(selectedKeys().size).toBe(0);
  });

  it('preserves native text selection and copying when dragging within one cell', () => {
    const cell = cells()[1]![0]!;
    pointer(cell, 'pointerdown', { clientX: 10, clientY: 10 });
    const move = pointer(cell, 'pointermove', { clientX: 35, clientY: 10 });
    pointer(cell, 'pointerup', { clientX: 35, clientY: 10 });
    expect(move.defaultPrevented).toBe(false);
    expect(selectedKeys().size).toBe(0);
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    const data = new Map<string, string>();
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => data.set(type, value) } });
    cell.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(data.size).toBe(0);
  });

  it('supports Cmd/Ctrl+A, keyboard ranges and Escape', () => {
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(selectedKeys().size).toBe(12);
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(selectedKeys().size).toBe(0);
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    expect(selectedKeys()).toEqual(new Set(['0:0', '1:0']));
  });

  it('settles when a mutation observer reapplies enhancement', async () => {
    let mutations = 0;
    const observer = new MutationObserver(() => {
      mutations += 1;
      ensureTableSelection(wrapper, LABELS);
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-markstream-enhancement-state'] });
    ensureTableSelection(wrapper, LABELS);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mutations).toBe(0);
    observer.disconnect();
  });

  it('prunes a replaced table after it leaves the markdown root', () => {
    wrapper.remove();
    pruneTableSelections(root);
    expect(wrapper.querySelectorAll('[data-md-table-cell]')).toHaveLength(0);
    expect(wrapper.querySelector('button')).toBeNull();
  });

  it('keeps ordinary clicks and double-click word copying out of region selection', () => {
    const cell = cells()[1]![0]!;
    for (let count = 0; count < 2; count += 1) {
      pointer(cell, 'pointerdown', { clientX: 10, clientY: 10 });
      pointer(cell, 'pointerup', { clientX: 10, clientY: 10 });
    }
    expect(selectedKeys().size).toBe(0);
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    const data = new Map<string, string>();
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => data.set(type, value) } });
    cell.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(data.size).toBe(0);
    const header = cells()[0]![1]!;
    pointer(header, 'pointerdown');
    pointer(header, 'pointerup');
    expect(selectedKeys().size).toBe(4);
  });

  it('does not start a region selection from native column resize handles', () => {
    const handle = document.createElement('button');
    handle.className = 'table-node__resize-handle';
    handle.setAttribute('aria-label', 'Resize columns 1 and 2');
    cells()[0]![0]!.appendChild(handle);
    pointer(handle, 'pointerdown', { clientX: 10, clientY: 10 });
    pointer(handle, 'pointermove', { clientX: 70, clientY: 10 });
    pointer(handle, 'pointerup', { clientX: 70, clientY: 10 });
    expect(selectedKeys().size).toBe(0);
    expect(wrapper.classList.contains('md-table-selecting')).toBe(false);
    handle.remove();
  });

  it('keeps the last valid endpoint when pointerup happens outside the table', () => {
    const grid = cells();
    pointer(grid[1]![0]!, 'pointerdown', { clientX: 10, clientY: 10 });
    pointer(grid[2]![1]!, 'pointermove', { clientX: 60, clientY: 60 });
    pointer(document.body, 'pointerup', { clientX: 500, clientY: 500 });
    expect(selectedKeys()).toEqual(new Set(['1:0', '1:1', '2:0', '2:1']));
    expect(tableSelectionText(wrapper, 'tsv')).toBe('Alice\tProduct\nBob\tR&D');
  });

  it('lets native text selections use Shift and arrow keys without creating a header region', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection);
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
    expect(selectedKeys().size).toBe(0);
  });

  it('updates the range anchor on an ordinary cell click before a Shift click', () => {
    const grid = cells();
    pointer(grid[1]![0]!, 'pointerdown', { clientX: 10, clientY: 10 });
    pointer(grid[1]![0]!, 'pointerup', { clientX: 10, clientY: 10 });
    expect(selectedKeys().size).toBe(0);
    pointer(grid[2]![1]!, 'pointerdown', { shiftKey: true, clientX: 50, clientY: 50 });
    pointer(grid[2]![1]!, 'pointerup', { shiftKey: true, clientX: 50, clientY: 50 });
    expect(selectedKeys()).toEqual(new Set(['1:0', '1:1', '2:0', '2:1']));
  });

  it('preserves explicit line breaks in TSV and HTML output', () => {
    wrapper.innerHTML = '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>first<br>second</td></tr></tbody></table>';
    table = wrapper.querySelector('table')!;
    ensureTableSelection(wrapper, LABELS);
    expect(selectEntireTable(wrapper)).toBe(true);
    expect(tableSelectionText(wrapper, 'tsv')).toBe('H\nfirst\nsecond');
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    const data = new Map<string, string>();
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => data.set(type, value) } });
    wrapper.dispatchEvent(event);
    expect(data.get('text/plain')).toBe('H\nfirst\nsecond');
    expect(data.get('text/html')).toBe('<table><tbody><tr><th>H</th></tr><tr><td>first<br>second</td></tr></tbody></table>');
  });

  it('does not select cells from another table or create out-of-range rows and columns', () => {
    const other = document.createElement('div');
    other.className = 'table-node-wrapper';
    other.innerHTML = '<table><thead><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead><tbody><tr><td>a1</td><td>b1</td><td>c1</td><td>d1</td></tr><tr><td>a2</td><td>b2</td><td>c2</td><td>d2</td></tr><tr><td>a3</td><td>b3</td><td>c3</td><td>d3</td></tr></tbody></table>';
    document.body.appendChild(other);
    ensureTableSelection(other, LABELS);
    const otherCell = other.querySelectorAll<HTMLTableCellElement>('tbody td')[11]!;
    pointer(cells()[1]![0]!, 'pointerdown', { clientX: 10, clientY: 10 });
    pointer(otherCell, 'pointermove', { clientX: 100, clientY: 100 });
    pointer(otherCell, 'pointerup', { clientX: 100, clientY: 100 });
    expect(selectedKeys()).toEqual(new Set());
    expect(other.querySelectorAll('.md-table-cell-selected')).toHaveLength(0);
    expect(tableSelectionText(wrapper, 'tsv')).toBeNull();
    destroyTableSelections(other);
  });

  it('generates stable unique JSON keys for duplicate and empty headers', () => {
    wrapper.innerHTML = '<table><thead><tr><th>Value</th><th>Value</th><th></th><th></th></tr></thead><tbody><tr><td>10</td><td>20</td><td>30</td><td>40</td></tr></tbody></table>';
    table = wrapper.querySelector('table')!;
    ensureTableSelection(wrapper, LABELS);
    expect(selectEntireTable(wrapper)).toBe(true);
    expect(JSON.parse(tableSelectionText(wrapper, 'json')!)).toEqual([{ Value: '10', 'Value (2)': '20', 'Column 3': '30', 'Column 4': '40' }]);
  });

  it('escapes visible Markdown syntax and preserves line breaks through export and quote serialization', () => {
    wrapper.innerHTML = '<table><thead><tr><th>*literal*</th><th>&lt;tag&gt;</th><th>C:\\path</th><th>x|y</th><th>Line</th></tr></thead><tbody><tr><td>*literal*</td><td>&lt;tag&gt;</td><td>C:\\path</td><td>x|y</td><td>first<br>second</td></tr></tbody></table>';
    table = wrapper.querySelector('table')!;
    ensureTableSelection(wrapper, LABELS);
    expect(selectEntireTable(wrapper)).toBe(true);
    const markdown = tableSelectionText(wrapper, 'markdown')!;
    expect(markdown).toBe(String.raw`| \*literal\* | &lt;tag&gt; | C:\\path | x\|y | Line |
| --- | --- | --- | --- | --- |
| \*literal\* | &lt;tag&gt; | C:\\path | x\|y | first<br>second |`);
    expect(markdownTableSources(markdown)).toEqual([markdown]);
  });
});

describe('table selection serialization', () => {
  it('copies TSV, Markdown, CSV and JSON', () => {
    const selected = new Set(['0:1', '0:2', '1:1', '1:2', '2:1', '2:2']);
    expect(serializeTableSelection(table, selected, 'markdown')).toBe('| Department | Note |\n| --- | --- |\n| Product | a,b |\n| R&amp;D | x\\|y |');
    expect(serializeTableSelection(table, selected, 'csv')).toBe('Department,Note\nProduct,"a,b"\nR&D,x|y');
    expect(JSON.parse(serializeTableSelection(table, selected, 'json'))).toEqual([
      { Department: 'Product', Note: 'a,b' },
      { Department: 'R&D', Note: 'x|y' },
    ]);
  });

  it('adds original headers when copying data-only rows as Markdown', () => {
    const selected = new Set(['2:1', '2:2']);
    expect(serializeTableSelection(table, selected, 'markdown')).toBe('| Department | Note |\n| --- | --- |\n| R&amp;D | x\\|y |');
  });

  it('writes rich and plain clipboard data for a native copy', () => {
    const grid = cells();
    pointer(grid[1]![0]!, 'pointerdown');
    pointer(grid[1]![1]!, 'pointermove', { clientX: 40, clientY: 0 });
    pointer(grid[1]![1]!, 'pointerup', { clientX: 40, clientY: 0 });
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    const data = new Map<string, string>();
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => data.set(type, value) } });
    wrapper.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(data.get('text/plain')).toBe('Alice\tProduct');
    expect(data.get('text/html')).toBe('<table><tbody><tr><td>Alice</td><td>Product</td></tr></tbody></table>');
  });

  it('keeps the selection while clicking the app-ui table context menus', () => {
    const header = cells()[0]![1]!;
    pointer(header, 'pointerdown');
    pointer(header, 'pointerup');
    expect(selectedKeys().size).toBe(4);
    for (const className of ['table-selection-context-menu', 'table-selection-copy-submenu']) {
      const menu = document.createElement('div');
      menu.className = className;
      document.body.appendChild(menu);
      pointer(menu, 'pointerdown');
      expect(selectedKeys().size).toBe(4);
      menu.remove();
    }
    pointer(document.body, 'pointerdown');
    expect(selectedKeys().size).toBe(0);
  });

  it('feeds the selection to copy actions and the native context menu', () => {
    const header = cells()[0]![1]!;
    pointer(header, 'pointerdown');
    pointer(header, 'pointerup');
    const actions = document.createElement('div');
    actions.className = 'md-table-actions';
    const copy = document.createElement('button');
    copy.className = 'md-table-copy';
    actions.appendChild(copy);
    root.appendChild(actions);
    pointer(copy, 'pointerdown');
    expect(tableSelectionText(wrapper)).toBe('Department\nProduct\nR&D\nDesign');
    expect(tableSelectionContextText(cells()[1]![1]!)).toBe('Department\nProduct\nR&D\nDesign');
    expect(tableSelectionContextText(document.body)).toBeNull();
    expect(selectedKeys().size).toBe(4);
    pointer(document.body, 'pointerdown');
    expect(tableSelectionText(wrapper)).toBeNull();
    expect(wrapper.classList.contains('md-table-has-selection')).toBe(false);
  });
});
