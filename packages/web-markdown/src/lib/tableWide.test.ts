import { beforeEach, describe, expect, it } from 'vitest';
import {
  ensureTableWideToggle,
  isTableWideHost,
  pinTableWideToggle,
  TABLE_AT_END_CLASS,
  TABLE_FADE_CLASS,
  TABLE_LAYOUT_EVENT,
  TABLE_TOGGLE_CLASS,
  TABLE_TOGGLE_SHOW_CLASS,
  TABLE_WIDE_CLASS,
  toggleTableWide,
  updateTableWideToggle,
} from './tableWide';

// Node has no DOM — these tests run against a minimal element stub that
// implements exactly the surface tableWide.ts uses (classList, dataset,
// recursive class querySelector, appendChild, innerHTML, scroll events,
// style, attributes).
class StubClassList {
  private tokens = new Set<string>();
  toggle(cls: string, force?: boolean): boolean {
    const next = force ?? !this.tokens.has(cls);
    if (next) this.tokens.add(cls);
    else this.tokens.delete(cls);
    return next;
  }
  contains(cls: string): boolean {
    return this.tokens.has(cls);
  }
  setFromString(value: string): void {
    this.tokens = new Set(value.split(/\s+/).filter(Boolean));
  }
}

interface StubEvent {
  type: string;
  bubbles: boolean;
  prevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

class StubElement {
  classList = new StubClassList();
  dataset: Record<string, string> = {};
  children: StubElement[] = [];
  title = '';
  type = '';
  textContent = '';
  clientWidth = 0;
  scrollWidth = 0;
  scrollLeft = 0;
  rectHeight = 0;
  rectTop = 0;
  style: Record<string, string> = {};
  hostContext: unknown = null;
  tableStub: StubElement | null = null;
  headerStub: StubElement | null = null;
  dispatched: Array<{ type: string; bubbles: boolean }> = [];
  private html = '';
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<(event: StubEvent) => void>>();

  set className(value: string) {
    this.classList.setFromString(value);
  }
  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
  }
  get innerHTML(): string {
    return this.html;
  }

  closest(_selector: string): unknown {
    return this.hostContext;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  appendChild<T extends StubElement>(child: T): T {
    this.children.push(child);
    return child;
  }
  addEventListener(type: string, fn: (event: StubEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatchEvent(event: { type: string; bubbles: boolean }): boolean {
    this.dispatched.push({ type: event.type, bubbles: event.bubbles });
    return true;
  }
  click(): void {
    const event: StubEvent = {
      type: 'click',
      bubbles: true,
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    };
    for (const fn of this.listeners.get('click') ?? []) fn(event);
  }
  scrollTo(x: number): void {
    this.scrollLeft = x;
    const event: StubEvent = {
      type: 'scroll',
      bubbles: false,
      prevented: false,
      stopped: false,
      preventDefault() {},
      stopPropagation() {},
    };
    for (const fn of this.listeners.get('scroll') ?? []) fn(event);
  }
  private findByClass(cls: string): StubElement | null {
    for (const child of this.children) {
      if (child.classList.contains(cls)) return child;
      const nested = child.findByClass(cls);
      if (nested) return nested;
    }
    return null;
  }
  getBoundingClientRect(): { top: number; height: number } {
    return { top: this.rectTop, height: this.rectHeight };
  }
  querySelector(selector: string): StubElement | null {
    if (selector === 'table') return this.tableStub;
    if (selector === 'thead tr' || selector === 'tr') return this.headerStub;
    const cls = selector.startsWith('button.') || selector.startsWith('div.')
      ? selector.slice(selector.indexOf('.') + 1)
      : selector.replace(/^\./, '');
    return this.findByClass(cls);
  }
}

const LABELS = { widen: 'Widen table', restore: 'Restore default width' };

function makeWrapper(opts: { clientWidth?: number; tableWidth?: number | null; headerHeight?: number } = {}) {
  const wrapper = new StubElement();
  wrapper.hostContext = {}; // truthy: inside `.a-msg .msg`
  wrapper.clientWidth = opts.clientWidth ?? 600;
  if (opts.tableWidth !== null) {
    const table = new StubElement();
    table.scrollWidth = opts.tableWidth ?? 1000;
    wrapper.tableStub = table;
    wrapper.appendChild(table);
    wrapper.scrollWidth = opts.tableWidth ?? 1000;
    const header = new StubElement();
    header.rectHeight = opts.headerHeight ?? 40;
    // The header row sits ~9px below the wrapper's top edge (table margin +
    // border), like the real markstream layout.
    wrapper.rectTop = 100;
    header.rectTop = 109;
    wrapper.headerStub = header;
  } else {
    wrapper.scrollWidth = wrapper.clientWidth;
  }
  return wrapper as unknown as HTMLElement;
}

function stubOf(el: HTMLElement): StubElement {
  return el as unknown as StubElement;
}

function chipOf(wrapper: HTMLElement): StubElement {
  return stubOf(wrapper).querySelector(`button.${TABLE_TOGGLE_CLASS}`)!;
}

function fadeOf(wrapper: HTMLElement): StubElement {
  return stubOf(wrapper).querySelector(`.${TABLE_FADE_CLASS}`)!;
}

beforeEach(() => {
  // ensureTableWideToggle calls document.createElement('div'/'button').
  (globalThis as Record<string, unknown>).document = {
    createElement: () => new StubElement(),
  };
});

describe('isTableWideHost', () => {
  it('is true only inside the chat assistant-message host', () => {
    const wrapper = makeWrapper();
    expect(isTableWideHost(wrapper)).toBe(true);
    wrapper.hostContext = null;
    expect(isTableWideHost(wrapper)).toBe(false);
  });
});

describe('ensureTableWideToggle', () => {
  it('appends the fade + chip after the table, idempotently', () => {
    const wrapper = makeWrapper();
    const button = ensureTableWideToggle(wrapper, LABELS)!;
    const kids = stubOf(wrapper).children;
    expect(kids.map((k) => (k === stubOf(wrapper).tableStub ? 'table' : k.classList.contains(TABLE_FADE_CLASS) ? 'fade' : 'chip'))).toEqual(['table', 'fade', 'chip']);
    expect(stubOf(button).getAttribute('aria-label')).toBe(LABELS.widen);
    expect(stubOf(button).title).toBe(LABELS.widen);
    expect(stubOf(button).innerHTML).toContain('15 3 21 3 21 9'); // maximize-2
    expect(ensureTableWideToggle(wrapper, LABELS)).toBe(button);
    expect(kids.filter((k) => k.classList.contains(TABLE_TOGGLE_CLASS))).toHaveLength(1);
    expect(kids.filter((k) => k.classList.contains(TABLE_FADE_CLASS))).toHaveLength(1);
  });

  it('does not inject outside the chat-message host context', () => {
    const wrapper = makeWrapper();
    wrapper.hostContext = null;
    expect(ensureTableWideToggle(wrapper, LABELS)).toBeNull();
    expect(stubOf(wrapper).children).toHaveLength(1); // just the table
  });

  it('marks chip + fade with --show on injection when the table overflows', () => {
    const wrapper = makeWrapper({ clientWidth: 600, tableWidth: 1000 });
    ensureTableWideToggle(wrapper, LABELS);
    expect(chipOf(wrapper).classList.contains(TABLE_TOGGLE_SHOW_CLASS)).toBe(true);
    expect(fadeOf(wrapper).classList.contains(TABLE_TOGGLE_SHOW_CLASS)).toBe(true);
  });

  it('marks neither when the table fits the wrapper', () => {
    const wrapper = makeWrapper({ clientWidth: 600, tableWidth: 500 });
    ensureTableWideToggle(wrapper, LABELS);
    expect(chipOf(wrapper).classList.contains(TABLE_TOGGLE_SHOW_CLASS)).toBe(false);
    expect(fadeOf(wrapper).classList.contains(TABLE_TOGGLE_SHOW_CLASS)).toBe(false);
  });
});

describe('toggleTableWide', () => {
  it('toggles the wide class, swaps the icon/label, and notifies ancestors', () => {
    const wrapper = makeWrapper();
    ensureTableWideToggle(wrapper, LABELS);
    toggleTableWide(wrapper, LABELS);
    const button = chipOf(wrapper);
    expect(stubOf(wrapper).classList.contains(TABLE_WIDE_CLASS)).toBe(true);
    expect(button.innerHTML).toContain('4 14 10 14 10 20'); // minimize-2
    expect(button.getAttribute('aria-label')).toBe(LABELS.restore);
    expect(stubOf(wrapper).dispatched).toEqual([{ type: TABLE_LAYOUT_EVENT, bubbles: true }]);

    toggleTableWide(wrapper, LABELS);
    expect(stubOf(wrapper).classList.contains(TABLE_WIDE_CLASS)).toBe(false);
    expect(button.innerHTML).toContain('15 3 21 3 21 9'); // maximize-2
    expect(button.getAttribute('aria-label')).toBe(LABELS.widen);
    expect(stubOf(wrapper).dispatched).toHaveLength(2);
  });

  it('keeps the chip visible while widened without overflow, but not the fade', () => {
    const wrapper = makeWrapper({ clientWidth: 600, tableWidth: 500 });
    stubOf(ensureTableWideToggle(wrapper, LABELS)!).click(); // widen
    expect(chipOf(wrapper).classList.contains(TABLE_TOGGLE_SHOW_CLASS)).toBe(true);
    expect(fadeOf(wrapper).classList.contains(TABLE_TOGGLE_SHOW_CLASS)).toBe(false);

    chipOf(wrapper).click(); // restore
    expect(chipOf(wrapper).classList.contains(TABLE_TOGGLE_SHOW_CLASS)).toBe(false);
    expect(fadeOf(wrapper).classList.contains(TABLE_TOGGLE_SHOW_CLASS)).toBe(false);
  });
});

describe('alignTableWideToggle (via updateTableWideToggle)', () => {
  it('centres the chip on the header row, right inset equal to top inset', () => {
    // header at +9 from wrapper top, 40px tall, chip 26px → 9 + (40-26)/2 = 16px
    const wrapper = makeWrapper({ headerHeight: 40 });
    ensureTableWideToggle(wrapper, LABELS);
    const chip = chipOf(wrapper);
    expect(chip.style.top).toBe('16px');
    expect(chip.style.right).toBe('16px');
  });

  it('re-measures when the header height changes (e.g. column resize wraps the header)', () => {
    const wrapper = makeWrapper({ headerHeight: 40 });
    ensureTableWideToggle(wrapper, LABELS);
    stubOf(wrapper).headerStub!.rectHeight = 60; // header grew
    updateTableWideToggle(wrapper);
    expect(chipOf(wrapper).style.top).toBe('26px');
    expect(chipOf(wrapper).style.right).toBe('26px');
  });

  it('never insets below 2px for very short headers', () => {
    const wrapper = makeWrapper({ headerHeight: 24 });
    stubOf(wrapper).headerStub!.rectTop = -40; // degenerate: header above wrapper
    stubOf(wrapper).rectTop = 0;
    ensureTableWideToggle(wrapper, LABELS);
    expect(chipOf(wrapper).style.top).toBe('2px');
  });
});

describe('pinTableWideToggle', () => {
  it('pins chip + fade at translateX(0) on injection', () => {
    const wrapper = makeWrapper();
    ensureTableWideToggle(wrapper, LABELS);
    expect(chipOf(wrapper).style.transform).toBe('translateX(0px)');
    expect(fadeOf(wrapper).style.transform).toBe('translateX(0px)');
  });

  it('translates both overlays back by scrollLeft so they stay docked while scrolling', () => {
    const wrapper = makeWrapper();
    ensureTableWideToggle(wrapper, LABELS);

    stubOf(wrapper).scrollTo(120);
    expect(chipOf(wrapper).style.transform).toBe('translateX(120px)');
    expect(fadeOf(wrapper).style.transform).toBe('translateX(120px)');
  });

  it('marks the wrapper at-end only when scrolled to the rightmost position', () => {
    const wrapper = makeWrapper({ clientWidth: 600, tableWidth: 1000 });
    ensureTableWideToggle(wrapper, LABELS);
    expect(stubOf(wrapper).classList.contains(TABLE_AT_END_CLASS)).toBe(false);

    stubOf(wrapper).scrollTo(400); // 400 + 600 = 1000 = scrollWidth → at end
    expect(stubOf(wrapper).classList.contains(TABLE_AT_END_CLASS)).toBe(true);

    stubOf(wrapper).scrollTo(0);
    expect(stubOf(wrapper).classList.contains(TABLE_AT_END_CLASS)).toBe(false);
  });

  it('no-ops when the wrapper has no overlays (not injected)', () => {
    const wrapper = makeWrapper();
    expect(() => pinTableWideToggle(wrapper)).not.toThrow();
  });
});

describe('updateTableWideToggle', () => {
  it('re-evaluates overflow, e.g. after a column resize', () => {
    const wrapper = makeWrapper({ clientWidth: 600, tableWidth: 1000 });
    ensureTableWideToggle(wrapper, LABELS);
    expect(chipOf(wrapper).classList.contains(TABLE_TOGGLE_SHOW_CLASS)).toBe(true);

    stubOf(wrapper).clientWidth = 1200; // column grew past the table width
    updateTableWideToggle(wrapper);
    expect(chipOf(wrapper).classList.contains(TABLE_TOGGLE_SHOW_CLASS)).toBe(false);
    expect(fadeOf(wrapper).classList.contains(TABLE_TOGGLE_SHOW_CLASS)).toBe(false);
  });

  it('no-ops when the wrapper has no chip (not injected)', () => {
    const wrapper = makeWrapper();
    expect(() => updateTableWideToggle(wrapper)).not.toThrow();
  });
});
