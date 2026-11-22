import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iconSvg } from '@moonshot-ai/app-client/icons';
import { CODE_TIP_ATTR } from './codeTooltip';
import {
  destroyTableWideToggles,
  ensureTableWideToggle,
  isTableWideHost,
  positionTableActions,
  pruneTableWideToggles,
  TABLE_ACTIONS_CLASS,
  TABLE_COPY_CLASS,
  TABLE_LAYOUT_EVENT,
  TABLE_TOGGLE_CLASS,
  TABLE_TOGGLE_EVENT,
  TABLE_WIDE_CLASS,
  toggleTableWide,
} from './tableWide';

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
  parent: StubElement | null = null;
  title = '';
  type = '';
  textContent = '';
  scrollLeft = 0;
  rectTop = 0;
  rectLeft = 0;
  rectRight = 0;
  rectHeight = 0;
  clientWidth = 0;
  overflowX = 'visible';
  style: Record<string, string> = {};
  hostContext: unknown = null;
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
  get parentElement(): StubElement | null {
    return this.parent;
  }
  get nextSibling(): StubElement | null {
    if (!this.parent) return null;
    const index = this.parent.children.indexOf(this);
    return this.parent.children[index + 1] ?? null;
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
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }
  insertBefore<T extends StubElement>(child: T, reference: StubElement | null): T {
    child.parent?.removeChild(child);
    child.parent = this;
    const index = reference === null ? -1 : this.children.indexOf(reference);
    if (index >= 0) this.children.splice(index, 0, child);
    else this.children.push(child);
    return child;
  }
  removeChild<T extends StubElement>(child: T): T {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
    return child;
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  contains(el: StubElement): boolean {
    for (let node: StubElement | null = el; node; node = node.parent) {
      if (node === this) return true;
    }
    return false;
  }
  addEventListener(type: string, fn: (event: StubEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (event: StubEvent) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
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
  getBoundingClientRect(): { top: number; left: number; right: number; width: number; height: number } {
    return {
      top: this.rectTop,
      left: this.rectLeft,
      right: this.rectRight,
      width: this.rectRight - this.rectLeft,
      height: this.rectHeight,
    };
  }
  querySelector(selector: string): StubElement | null {
    if (selector.startsWith(':scope > .')) {
      const cls = selector.slice(':scope > .'.length);
      return this.children.find((child) => child.classList.contains(cls)) ?? null;
    }
    const cls = selector.startsWith('button.') || selector.startsWith('div.')
      ? selector.slice(selector.indexOf('.') + 1)
      : selector.replace(/^\./, '');
    return this.findByClass(cls);
  }
}

class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  readonly observed: StubElement[] = [];
  disconnected = false;
  constructor(private readonly callback: () => void) {
    StubResizeObserver.instances.push(this);
  }
  observe(el: Element): void { this.observed.push(el as unknown as StubElement); }
  unobserve(): void {}
  disconnect(): void { this.disconnected = true; }
  fire(): void { this.callback(); }
}

const LABELS = { widen: 'Widen table', restore: 'Restore default width', copy: 'Copy table' };
const TABLE_SOURCE = '| Name | Type |\n| --- | --- |\n| Alpha | service |';

function makeWrapper(opts: { rectTop?: number; rectRight?: number; root?: unknown } = {}) {
  const host = new StubElement();
  const wrapper = new StubElement();
  wrapper.hostContext = opts.root ?? {};
  wrapper.rectTop = opts.rectTop ?? 100;
  wrapper.rectRight = opts.rectRight ?? 600;
  wrapper.appendChild(new StubElement());
  host.appendChild(wrapper);
  return wrapper as unknown as HTMLElement;
}

function stubOf(el: HTMLElement): StubElement {
  return el as unknown as StubElement;
}

function hostOf(wrapper: HTMLElement): StubElement {
  return stubOf(wrapper).parent!;
}

function makeWrapperInHost(host: StubElement, opts: { rectTop?: number; rectRight?: number; root?: unknown } = {}) {
  const wrapper = new StubElement();
  wrapper.hostContext = opts.root ?? {};
  wrapper.rectTop = opts.rectTop ?? 100;
  wrapper.rectRight = opts.rectRight ?? 600;
  wrapper.appendChild(new StubElement());
  host.appendChild(wrapper);
  return wrapper as unknown as HTMLElement;
}

function actionsInHost(host: StubElement): StubElement[] {
  return host.children.filter((child) => child.classList.contains(TABLE_ACTIONS_CLASS));
}

function actionsOf(wrapper: HTMLElement): StubElement {
  return actionsInHost(hostOf(wrapper))[0]!;
}

function chipOf(wrapper: HTMLElement): StubElement {
  return actionsOf(wrapper).querySelector(`button.${TABLE_TOGGLE_CLASS}`)!;
}

function copyOf(wrapper: HTMLElement): StubElement {
  return actionsOf(wrapper).querySelector(`button.${TABLE_COPY_CLASS}`)!;
}

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  StubResizeObserver.instances = [];
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  (globalThis as Record<string, unknown>).document = {
    createElement: () => new StubElement(),
  };
  (globalThis as Record<string, unknown>).ResizeObserver = StubResizeObserver;
  (globalThis as Record<string, unknown>).getComputedStyle = (el?: StubElement) => ({
    columnGap: '6px',
    overflowX: el?.overflowX ?? 'visible',
  });
  vi.stubGlobal('navigator', { clipboard: { writeText } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
  it('appends the fade to the wrapper and the actions with toggle + copy to the host, idempotently', () => {
    const wrapper = makeWrapper();
    const toggle = ensureTableWideToggle(wrapper, LABELS, () => TABLE_SOURCE)!;
    expect(stubOf(wrapper).children).toHaveLength(1);
    const actions = actionsOf(wrapper);
    expect(actions.children.map((k) => (k.classList.contains(TABLE_TOGGLE_CLASS) ? 'toggle' : 'copy'))).toEqual(['toggle', 'copy']);
    expect(stubOf(toggle).getAttribute('aria-label')).toBe(LABELS.widen);
    expect(stubOf(toggle).getAttribute(CODE_TIP_ATTR)).toBe(LABELS.widen);
    expect(stubOf(toggle).title).toBe('');
    expect(stubOf(toggle).innerHTML).toContain('15 3 21 3 21 9');
    expect(copyOf(wrapper).getAttribute('aria-label')).toBe(LABELS.copy);
    expect(copyOf(wrapper).getAttribute(CODE_TIP_ATTR)).toBe(LABELS.copy);
    expect(copyOf(wrapper).title).toBe('');
    expect(ensureTableWideToggle(wrapper, LABELS, () => TABLE_SOURCE)).toBe(toggle);
    expect(hostOf(wrapper).children.filter((k) => k.classList.contains(TABLE_ACTIONS_CLASS))).toHaveLength(1);
  });

  it('skips the copy button when no source resolver is provided', () => {
    const wrapper = makeWrapper();
    ensureTableWideToggle(wrapper, LABELS);
    expect(actionsOf(wrapper).children).toHaveLength(1);
    expect(actionsOf(wrapper).children[0]!.classList.contains(TABLE_TOGGLE_CLASS)).toBe(true);
  });

  it('refreshes all button labels on re-ensure, honoring the wide state', () => {
    const wrapper = makeWrapper();
    const localized = { widen: '加宽表格', restore: '恢复默认宽度', copy: '复制表格' };
    ensureTableWideToggle(wrapper, LABELS, () => TABLE_SOURCE);
    expect(chipOf(wrapper).getAttribute('aria-label')).toBe(LABELS.widen);
    expect(copyOf(wrapper).getAttribute('aria-label')).toBe(LABELS.copy);

    ensureTableWideToggle(wrapper, localized, () => TABLE_SOURCE);
    expect(chipOf(wrapper).getAttribute('aria-label')).toBe(localized.widen);
    expect(chipOf(wrapper).getAttribute(CODE_TIP_ATTR)).toBe(localized.widen);
    expect(copyOf(wrapper).getAttribute('aria-label')).toBe(localized.copy);
    expect(copyOf(wrapper).getAttribute(CODE_TIP_ATTR)).toBe(localized.copy);

    toggleTableWide(wrapper, localized);
    ensureTableWideToggle(wrapper, LABELS, () => TABLE_SOURCE);
    expect(chipOf(wrapper).getAttribute('aria-label')).toBe(LABELS.restore);
    expect(chipOf(wrapper).getAttribute(CODE_TIP_ATTR)).toBe(LABELS.restore);
  });

  it('does not inject outside the chat-message host context', () => {
    const wrapper = makeWrapper();
    wrapper.hostContext = null;
    expect(ensureTableWideToggle(wrapper, LABELS, () => TABLE_SOURCE)).toBeNull();
    expect(stubOf(wrapper).children).toHaveLength(1);
    expect(hostOf(wrapper).children).toHaveLength(1);
  });

  it('binds one actions stack per table when siblings share a single parent', () => {
    const host = new StubElement();
    const first = makeWrapperInHost(host, { rectRight: 600 });
    const second = makeWrapperInHost(host, { rectRight: 900 });
    const resolverFirst = vi.fn().mockReturnValue('first');
    const resolverSecond = vi.fn().mockReturnValue('second');
    ensureTableWideToggle(first, LABELS, resolverFirst);
    ensureTableWideToggle(second, LABELS, resolverSecond);

    const [actionsFirst, actionsSecond] = actionsInHost(host);
    expect(actionsInHost(host)).toHaveLength(2);
    expect(host.children.indexOf(actionsFirst!)).toBe(host.children.indexOf(first) + 1);
    expect(host.children.indexOf(actionsSecond!)).toBe(host.children.indexOf(second) + 1);
    expect(actionsFirst!.style.left).toBe('606px');
    expect(actionsSecond!.style.left).toBe('906px');

    toggleTableWide(second, LABELS);
    expect(stubOf(first).classList.contains(TABLE_WIDE_CLASS)).toBe(false);
    expect(stubOf(second).classList.contains(TABLE_WIDE_CLASS)).toBe(true);
    expect(actionsFirst!.querySelector(`button.${TABLE_TOGGLE_CLASS}`)!.innerHTML).toContain('15 3 21 3 21 9');
    expect(actionsSecond!.querySelector(`button.${TABLE_TOGGLE_CLASS}`)!.innerHTML).toContain('4 14 10 14 10 20');

    actionsSecond!.querySelector(`button.${TABLE_COPY_CLASS}`)!.click();
    expect(resolverSecond).toHaveBeenCalledWith(second);
    expect(resolverFirst).not.toHaveBeenCalled();
  });

  it('rebuilds the actions when the wrapper is re-parented', () => {
    const hostA = new StubElement();
    const hostB = new StubElement();
    const wrapper = makeWrapperInHost(hostA);
    const toggle = ensureTableWideToggle(wrapper, LABELS)!;
    expect(actionsInHost(hostA)).toHaveLength(1);

    hostB.appendChild(wrapper);
    expect(ensureTableWideToggle(wrapper, LABELS)).not.toBe(toggle);
    expect(actionsInHost(hostA)).toHaveLength(0);
    expect(actionsInHost(hostB)).toHaveLength(1);
    expect(StubResizeObserver.instances[0]!.disconnected).toBe(true);
    expect(StubResizeObserver.instances[1]!.observed).toEqual([wrapper, hostB]);

    hostA.appendChild(wrapper);
    ensureTableWideToggle(wrapper, LABELS);
    expect(stubOf(wrapper).listenerCount('scroll')).toBe(0);
  });
});

describe('toggleTableWide', () => {
  it('toggles the wide class, swaps the icon/label, and notifies ancestors', () => {
    const wrapper = makeWrapper();
    ensureTableWideToggle(wrapper, LABELS);
    toggleTableWide(wrapper, LABELS);
    const button = chipOf(wrapper);
    expect(stubOf(wrapper).classList.contains(TABLE_WIDE_CLASS)).toBe(true);
    expect(button.innerHTML).toContain('4 14 10 14 10 20');
    expect(button.getAttribute('aria-label')).toBe(LABELS.restore);
    expect(stubOf(wrapper).dispatched).toEqual([{ type: TABLE_LAYOUT_EVENT, bubbles: true }]);

    toggleTableWide(wrapper, LABELS);
    expect(stubOf(wrapper).classList.contains(TABLE_WIDE_CLASS)).toBe(false);
    expect(button.innerHTML).toContain('15 3 21 3 21 9');
    expect(button.getAttribute('aria-label')).toBe(LABELS.widen);
    expect(stubOf(wrapper).dispatched).toHaveLength(2);
  });

  it('announces user toggles before the width changes, unlike restored state', () => {
    const wrapper = makeWrapper();
    stubOf(ensureTableWideToggle(wrapper, LABELS)!).click();
    expect(stubOf(wrapper).dispatched.map(event => event.type)).toEqual([TABLE_TOGGLE_EVENT, TABLE_LAYOUT_EVENT]);
    toggleTableWide(wrapper, LABELS);
    expect(stubOf(wrapper).dispatched.map(event => event.type)).toEqual([TABLE_TOGGLE_EVENT, TABLE_LAYOUT_EVENT, TABLE_LAYOUT_EVENT]);
  });

  it('uses the latest labels for clicks after a locale switch', () => {
    const localized = { widen: '加宽表格', restore: '恢复默认宽度', copy: '复制表格' };
    const wrapper = makeWrapper();
    stubOf(ensureTableWideToggle(wrapper, LABELS)!).click();
    expect(chipOf(wrapper).getAttribute('aria-label')).toBe(LABELS.restore);

    ensureTableWideToggle(wrapper, localized);
    expect(chipOf(wrapper).getAttribute('aria-label')).toBe(localized.restore);

    chipOf(wrapper).click();
    expect(chipOf(wrapper).getAttribute('aria-label')).toBe(localized.widen);
    expect(chipOf(wrapper).getAttribute(CODE_TIP_ATTR)).toBe(localized.widen);
  });
});

describe('table actions positioning', () => {
  it('places the actions outside the wrapper’s right edge, aligned with its top', () => {
    const wrapper = makeWrapper({ rectTop: 100, rectRight: 600 });
    ensureTableWideToggle(wrapper, LABELS);
    const actions = actionsOf(wrapper);
    expect(actions.style.left).toBe('606px');
    expect(actions.style.top).toBe('100px');
  });

  it('tracks the wrapper edge when it moves, e.g. after widening or a column resize', () => {
    const wrapper = makeWrapper({ rectRight: 600 });
    ensureTableWideToggle(wrapper, LABELS);
    expect(actionsOf(wrapper).style.left).toBe('606px');

    stubOf(wrapper).rectRight = 900;
    StubResizeObserver.instances[0]!.fire();
    expect(actionsOf(wrapper).style.left).toBe('906px');
  });

  it('reads the gap from the computed action-gap token instead of a fixed pixel constant', () => {
    (globalThis as Record<string, unknown>).getComputedStyle = () => ({ columnGap: '4.5px' });
    const wrapper = makeWrapper({ rectRight: 600 });
    ensureTableWideToggle(wrapper, LABELS);
    expect(actionsOf(wrapper).style.left).toBe('604.5px');
  });

  it('keeps the actions glued to the frame for every frame of the widen transition', () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const wrapper = makeWrapper({ rectRight: 600 });
    ensureTableWideToggle(wrapper, LABELS);
    expect(actionsOf(wrapper).style.left).toBe('606px');

    chipOf(wrapper).click();
    for (const edge of [700, 820, 940]) {
      stubOf(wrapper).rectRight = edge;
      frames.shift()!(0);
      expect(actionsOf(wrapper).style.left).toBe(`${edge + 6}px`);
    }
    expect(frames).not.toHaveLength(0);
  });

  it('stops tracking once the motion token duration has elapsed', () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const wrapper = makeWrapper({ rectRight: 600 });
    ensureTableWideToggle(wrapper, LABELS);

    chipOf(wrapper).click();
    frames.shift()!(0);
    expect(frames).toHaveLength(1);

    vi.advanceTimersByTime(160);
    frames.shift()!(0);
    expect(frames).toHaveLength(0);

    stubOf(wrapper).rectRight = 999;
    expect(actionsOf(wrapper).style.left).not.toBe('1005px');
  });

  it('observes both the wrapper and its host', () => {
    const wrapper = makeWrapper();
    ensureTableWideToggle(wrapper, LABELS);
    expect(StubResizeObserver.instances).toHaveLength(1);
    expect(StubResizeObserver.instances[0]!.observed).toEqual([wrapper, hostOf(wrapper)]);
  });

  it('observes clipping ancestors and recomputes when their bounds change', () => {
    const wrapper = makeWrapper({ rectRight: 600 });
    const pane = new StubElement();
    pane.rectRight = 900;
    pane.clientWidth = 900;
    pane.overflowX = 'auto';
    pane.appendChild(hostOf(wrapper));
    ensureTableWideToggle(wrapper, LABELS);
    const actions = actionsOf(wrapper);
    stubOf(actions).rectRight = 26;
    const observer = StubResizeObserver.instances[0]!;
    expect(observer.observed).toEqual([wrapper, hostOf(wrapper), pane]);
    expect(actions.style.left).toBe('606px');

    pane.clientWidth = 620;
    observer.fire();
    expect(actions.style.left).toBe('568px');

    pane.clientWidth = 900;
    observer.fire();
    expect(actions.style.left).toBe('606px');
  });
});

describe('positionTableActions', () => {
  it('re-places the actions on demand, e.g. after a column resize', () => {
    const wrapper = makeWrapper({ rectRight: 600 });
    ensureTableWideToggle(wrapper, LABELS);

    stubOf(wrapper).rectRight = 750;
    positionTableActions(wrapper);
    expect(actionsOf(wrapper).style.left).toBe('756px');
  });

  it('moves the actions inside the visible right edge when the outside position would be clipped', () => {
    const wrapper = makeWrapper({ rectRight: 600 });
    const pane = new StubElement();
    pane.rectRight = 620;
    pane.clientWidth = 620;
    pane.overflowX = 'auto';
    pane.appendChild(hostOf(wrapper));
    ensureTableWideToggle(wrapper, LABELS);
    const actions = actionsOf(wrapper);
    stubOf(actions).rectRight = 26;

    positionTableActions(wrapper);
    expect(actions.style.left).toBe('568px');

    stubOf(wrapper).rectRight = 650;
    positionTableActions(wrapper);
    expect(actions.style.left).toBe('588px');

    stubOf(wrapper).rectRight = 500;
    positionTableActions(wrapper);
    expect(actions.style.left).toBe('506px');
  });

  it('no-ops when the wrapper has no actions (not injected)', () => {
    const wrapper = makeWrapper();
    expect(() => positionTableActions(wrapper)).not.toThrow();
  });
});

describe('table copy button', () => {
  it('copies the resolved markdown source and flashes the check icon briefly', async () => {
    vi.useFakeTimers();
    const wrapper = makeWrapper();
    const resolver = vi.fn().mockReturnValue(TABLE_SOURCE);
    ensureTableWideToggle(wrapper, LABELS, resolver);
    const copy = copyOf(wrapper);

    copy.click();
    expect(resolver).toHaveBeenCalledWith(wrapper);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith(TABLE_SOURCE);
    expect(copy.innerHTML).toBe(iconSvg('check', 'sm'));

    await vi.advanceTimersByTimeAsync(1400);
    expect(copy.innerHTML).toBe(iconSvg('copy', 'sm'));
  });

  it('does nothing when the resolver finds no source', async () => {
    const wrapper = makeWrapper();
    ensureTableWideToggle(wrapper, LABELS, () => null);
    const copy = copyOf(wrapper);

    copy.click();
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
    expect(copy.innerHTML).toBe(iconSvg('copy', 'sm'));
  });
});

describe('table actions teardown', () => {
  it('prunes only the calling root’s detached wrappers, never another instance’s', () => {
    const root = new StubElement();
    const otherRoot = new StubElement();
    const hostA = new StubElement();
    const hostB = new StubElement();
    const foreignHost = new StubElement();
    root.appendChild(hostA);
    root.appendChild(hostB);
    otherRoot.appendChild(foreignHost);
    const keep = makeWrapperInHost(hostA, { root });
    const gone = makeWrapperInHost(hostB, { root });
    const foreign = makeWrapperInHost(foreignHost, { root: otherRoot });
    ensureTableWideToggle(keep, LABELS);
    ensureTableWideToggle(gone, LABELS);
    ensureTableWideToggle(foreign, LABELS);
    expect(StubResizeObserver.instances).toHaveLength(3);

    hostB.remove();
    pruneTableWideToggles(root as unknown as HTMLElement);
    expect(StubResizeObserver.instances[0]!.disconnected).toBe(false);
    expect(StubResizeObserver.instances[1]!.disconnected).toBe(true);
    expect(StubResizeObserver.instances[2]!.disconnected).toBe(false);
    expect(actionsInHost(hostA)).toHaveLength(1);
    expect(actionsInHost(hostB)).toHaveLength(0);
    expect(actionsInHost(foreignHost)).toHaveLength(1);

    ensureTableWideToggle(keep, LABELS);
    expect(actionsInHost(hostA)).toHaveLength(1);
  });

  it('destroys only the unmounted root’s actions, including pending copy feedback timers', async () => {
    vi.useFakeTimers();
    const root = new StubElement();
    const otherRoot = new StubElement();
    const wrapper = makeWrapper({ root });
    const foreign = makeWrapper({ root: otherRoot });
    ensureTableWideToggle(wrapper, LABELS, () => TABLE_SOURCE);
    ensureTableWideToggle(foreign, LABELS, () => TABLE_SOURCE);
    const copy = copyOf(wrapper);
    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(copy.innerHTML).toBe(iconSvg('check', 'sm'));

    destroyTableWideToggles(root as unknown as HTMLElement);
    expect(StubResizeObserver.instances[0]!.disconnected).toBe(true);
    expect(StubResizeObserver.instances[1]!.disconnected).toBe(false);
    expect(hostOf(wrapper).children.filter((child) => child.classList.contains(TABLE_ACTIONS_CLASS))).toHaveLength(0);
    expect(hostOf(foreign).children.filter((child) => child.classList.contains(TABLE_ACTIONS_CLASS))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1400);
    expect(copy.innerHTML).toBe(iconSvg('check', 'sm'));

    expect(ensureTableWideToggle(wrapper, LABELS, () => TABLE_SOURCE)).not.toBeNull();
    expect(actionsOf(wrapper)).toBeTruthy();
  });
});
