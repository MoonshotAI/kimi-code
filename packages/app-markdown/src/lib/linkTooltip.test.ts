import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { openDialogCount, openMenuCount, openSheetCount } from '@moonshot-ai/app-ui';
import {
  ensureLinkTooltip,
  syncLinkTooltipWithAnchor,
  hideLinkTooltipIfAnchorWithin,
  linkTooltipAnchorOf,
  type LinkTooltipHost,
} from './linkTooltip';

type StubListener = (event: never) => void;

class StubEl {
  tag: string;
  id = '';
  type = '';
  className = '';
  textContent = '';
  innerHTML = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  offsetWidth = 60;
  offsetHeight = 24;
  isConnected = true;
  focusVisible = false;
  focused = false;
  parent: StubEl | null = null;
  children: (StubEl | string)[] = [];
  classes = new Set<string>();
  attrs = new Map<string, string>();
  listeners = new Map<string, StubListener[]>();
  classList = {
    add: (c: string): void => {
      this.classes.add(c);
    },
    remove: (c: string): void => {
      this.classes.delete(c);
    },
    contains: (c: string): boolean => this.classes.has(c),
  };

  constructor(tag = 'div') {
    this.tag = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  matches(selector: string): boolean {
    if (selector === ':focus-visible') return this.focusVisible;
    return matchesSimple(this, selector);
  }

  append(...nodes: (StubEl | string)[]): void {
    for (const node of nodes) {
      if (typeof node !== 'string') node.parent = this;
      this.children.push(node);
    }
  }

  appendChild<T extends StubEl>(child: T): T {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes: (StubEl | string)[]): void {
    this.children = [];
    this.append(...nodes);
  }

  contains(el: StubEl | null): boolean {
    return ancestorChainIncludes(this, el);
  }

  closest(selector: string): StubEl | null {
    return closestOf(this, selector);
  }

  addEventListener(type: string, fn: StubListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  dispatch(type: string, event: object): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event as never);
  }

  querySelectorAll(selector: string): StubEl[] {
    const out: StubEl[] = [];
    const walk = (el: StubEl): void => {
      for (const child of el.children) {
        if (typeof child === 'string') continue;
        if (matchesSimple(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): StubEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  focus(): void {
    this.focused = true;
  }

  rect = { top: 100, left: 100, width: 40, height: 16, bottom: 116, right: 140 };

  getBoundingClientRect(): { top: number; left: number; width: number; height: number; bottom: number; right: number } {
    return this.rect;
  }
}

function matchesSimple(el: StubEl, selector: string): boolean {
  if (selector === 'a[href]') return el.tag === 'A' && el.attrs.has('href');
  if (selector === 'svg') return el.tag === 'SVG';
  if (selector === 'button') return el.tag === 'BUTTON';
  if (selector.startsWith('.')) return el.classes.has(selector.slice(1));
  return false;
}

function closestOf(start: StubEl, selector: string): StubEl | null {
  let cur: StubEl | null = start;
  while (cur) {
    if (matchesSimple(cur, selector)) return cur;
    cur = cur.parent;
  }
  return null;
}

function ancestorChainIncludes(root: StubEl, el: StubEl | null): boolean {
  let cur = el;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parent;
  }
  return false;
}

function stubEvent(target: StubEl | null, extra: Record<string, unknown> = {}) {
  return {
    target,
    relatedTarget: null,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault(this: { defaultPrevented: boolean }): void {
      this.defaultPrevented = true;
    },
    stopPropagation(this: { propagationStopped: boolean }): void {
      this.propagationStopped = true;
    },
    stopImmediatePropagation(this: { propagationStopped: boolean }): void {
      this.propagationStopped = true;
    },
    ...extra,
  };
}

describe('linkTooltip singleton (ensureLinkTooltip)', () => {
  const docListeners = new Map<string, Array<(event: never) => void>>();
  const winListeners = new Map<string, Array<() => void>>();
  const timers = new Map<number, () => void>();
  const state = {
    timerMode: 'immediate' as 'immediate' | 'manual',
    clearCount: 0,
    lastDelay: -1,
    opened: [] as { url: string; target: string; features: string }[],
    sidebarOpened: [] as string[],
  };
  let nextTimerId = 0;
  const head = {
    appended: [] as StubEl[],
    appendChild(child: StubEl): StubEl {
      this.appended.push(child);
      return child;
    },
  };
  const body = {
    appended: [] as StubEl[],
    appendChild(child: StubEl): StubEl {
      this.appended.push(child);
      return child;
    },
  };

  const fullHost: LinkTooltipHost = {
    openExternalLabel: () => 'External',
    openInSidebarLabel: () => 'Sidebar',
    resolveOpenInSidebar: () => (url) => {
      state.sidebarOpened.push(url);
    },
  };

  function bubble(): StubEl {
    return body.appended[0]!;
  }
  function visibleNow(): boolean {
    return bubble().classList.contains('md-link-tip--visible');
  }
  function actionButtons(): StubEl[] {
    return bubble().querySelectorAll('button');
  }
  let moveSeq = 0;
  function firePointerMove(target: StubEl, at?: { x: number; y: number }): void {
    moveSeq += 1;
    const event = { target, clientX: at?.x ?? moveSeq, clientY: at?.y ?? moveSeq };
    for (const fn of docListeners.get('pointermove') ?? []) fn(event as never);
  }
  function makeLink(href: string): StubEl {
    const root = new StubEl();
    root.classes.add('md');
    const link = new StubEl('a');
    link.setAttribute('href', href);
    root.appendChild(link);
    return link;
  }
  let lastAnchor: StubEl | null = null;
  function hoverLink(href: string): StubEl {
    const link = makeLink(href);
    lastAnchor = link;
    firePointerMove(link);
    return link;
  }
  function leave(): void {
    fireDoc('mouseout', { target: lastAnchor, relatedTarget: null });
  }
  function fireDoc(type: string, event: object): void {
    for (const fn of docListeners.get(type) ?? []) fn(event as never);
  }
  function runTimers(): void {
    timers.forEach((fn) => fn());
    timers.clear();
  }

  beforeAll(() => {
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => new StubEl(tag),
      getElementById: () => null,
      activeElement: null as StubEl | null,
      head,
      body,
      addEventListener: (type: string, fn: (event: never) => void) => {
        docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
      },
      documentElement: {
        addEventListener: (type: string, fn: (event: never) => void) => {
          docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
        },
      },
    };
    (globalThis as Record<string, unknown>).Element = StubEl;
    (globalThis as Record<string, unknown>).Node = StubEl;
    (globalThis as Record<string, unknown>).getComputedStyle = () => ({
      getPropertyValue: () => '',
    });
    (globalThis as Record<string, unknown>).window = {
      addEventListener: (type: string, fn: () => void) => {
        winListeners.set(type, [...(winListeners.get(type) ?? []), fn]);
      },
      innerWidth: 1000,
      innerHeight: 800,
      open: (url: string, target: string, features: string) => {
        state.opened.push({ url, target, features });
      },
      setTimeout: (fn: () => void, ms: number) => {
        state.lastDelay = ms;
        if (state.timerMode === 'immediate') {
          fn();
          return -1;
        }
        const id = ++nextTimerId;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id: number) => {
        state.clearCount += 1;
        timers.delete(id);
      },
    };
    ensureLinkTooltip(fullHost);
    firePointerMove(new StubEl());
    firePointerMove(new StubEl());
  });

  beforeEach(() => {
    ensureLinkTooltip(fullHost);
    leave();
    runTimers();
    state.timerMode = 'immediate';
    state.opened = [];
    state.sidebarOpened = [];
  });

  it('starts once: one stylesheet, one bubble, one listener set', () => {
    ensureLinkTooltip();
    expect(head.appended).toHaveLength(1);
    expect(head.appended[0]!.id).toBe('md-link-tip-style');
    const css = head.appended[0]!.textContent;
    expect(css).toContain('var(--color-text)');
    expect(css).toContain('var(--z-tooltip)');
    expect(css).toContain('max-width: var(--p-tip-max-w);');
    expect(css).toContain('-webkit-line-clamp: 3;');
    expect(css).toContain('font-weight: var(--weight-semibold);');
    expect(css).toContain('box-shadow: var(--p-focus-ring);');
    expect(css).toContain('font: inherit;');
    expect(css).toContain('text-overflow: ellipsis;');
    expect(css).not.toContain('280px');
    expect(body.appended).toHaveLength(1);
    expect(bubble().getAttribute('role')).toBeNull();
    expect(docListeners.get('mouseover')).toBeUndefined();
    expect(docListeners.get('pointermove')).toHaveLength(2);
  });

  it('resolves eligible anchors: http(s) links inside a markdown root', () => {
    expect(linkTooltipAnchorOf(makeLink('https://example.com/x'))?.getAttribute('href')).toBe('https://example.com/x');
    expect(linkTooltipAnchorOf(makeLink('http://example.com'))).not.toBeNull();
    expect(linkTooltipAnchorOf(makeLink('/relative/path'))).toBeNull();
    expect(linkTooltipAnchorOf(makeLink('kimi-code://skill/deploy'))).toBeNull();
    expect(linkTooltipAnchorOf(makeLink('mailto:user@example.com'))).toBeNull();

    const orphan = new StubEl('a');
    orphan.setAttribute('href', 'https://example.com');
    expect(linkTooltipAnchorOf(orphan)).toBeNull();

    const mention = makeLink('https://example.com');
    mention.dataset.mdLinkHandled = 'true';
    expect(linkTooltipAnchorOf(mention)).toBeNull();

    const svg = new StubEl('svg');
    const inSvg = new StubEl('a');
    inSvg.setAttribute('href', 'https://example.com');
    const md = new StubEl();
    md.classes.add('md');
    svg.appendChild(inSvg);
    md.appendChild(svg);
    expect(linkTooltipAnchorOf(inSvg)).toBeNull();

    const nested = new StubEl('b');
    const host = makeLink('https://example.com/nested');
    host.appendChild(nested);
    expect(linkTooltipAnchorOf(nested)?.getAttribute('href')).toBe('https://example.com/nested');
  });

  it('shows the full URL with the registered domain bolded after the token show delay', () => {
    state.timerMode = 'manual';
    const link = hoverLink('https://sub.example.co.uk/a/long/path?q=1#f');
    expect(state.lastDelay).toBe(150);
    expect(timers.size).toBe(1);
    runTimers();
    expect(visibleNow()).toBe(true);
    const text = bubble().children[0] as StubEl;
    expect(text.className).toBe('md-link-tip-text');
    expect(text.getAttribute('role')).toBe('tooltip');
    const domain = text.children.find((c): c is StubEl => typeof c !== 'string' && c.tag === 'B') as StubEl;
    expect(domain.className).toBe('md-link-tip-domain');
    expect(domain.textContent).toBe('example.co.uk');
    const rendered = text.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    expect(rendered).toBe('https://sub.example.co.uk/a/long/path?q=1#f');
    expect(link.getAttribute('aria-describedby')).toBe('md-link-tip-text');
    leave();
    runTimers();
    expect(visibleNow()).toBe(false);
    expect(link.getAttribute('aria-describedby')).toBeNull();
  });

  it('falls back to plain text when the URL cannot be parsed', () => {
    const link = makeLink('https://example.com/x');
    link.setAttribute('href', 'https://');
    lastAnchor = link;
    firePointerMove(link);
    expect(visibleNow()).toBe(true);
    const text = bubble().children[0] as StubEl;
    expect(text.className).toBe('md-link-tip-text');
    expect(text.children.every((c) => typeof c !== 'string' && c.tag !== 'B')).toBe(true);
    expect(text.textContent).toBe('https://');
  });

  it('does not show on a synthetic coordinate replay (element materializing under a parked cursor)', () => {
    state.timerMode = 'manual';
    firePointerMove(new StubEl());
    const settled = moveSeq;
    const link = makeLink('https://example.com');
    lastAnchor = link;
    firePointerMove(link, { x: settled, y: settled });
    expect(timers.size).toBe(0);
    firePointerMove(link);
    expect(timers.size).toBe(1);
  });

  it('does not retrigger while moving inside the same link, and retargets across links', () => {
    state.timerMode = 'manual';
    const first = hoverLink('https://a.example.com');
    expect(timers.size).toBe(1);
    const nested = new StubEl('span');
    first.appendChild(nested);
    firePointerMove(nested);
    expect(timers.size).toBe(1);
    const second = makeLink('https://b.example.com');
    lastAnchor = second;
    firePointerMove(second);
    expect(timers.size).toBe(1);
  });

  it('clears the previous anchor description when focus jumps straight to another link', () => {
    const first = makeLink('https://a.example.com');
    first.focusVisible = true;
    fireDoc('focusin', { target: first });
    expect(visibleNow()).toBe(true);
    expect(first.getAttribute('aria-describedby')).toBe('md-link-tip-text');
    const second = makeLink('https://b.example.com');
    second.focusVisible = true;
    fireDoc('focusin', { target: second });
    runTimers();
    expect(first.getAttribute('aria-describedby')).toBeNull();
    expect(second.getAttribute('aria-describedby')).toBe('md-link-tip-text');
  });

  it('hides the previous link actions immediately when focus jumps to another link', () => {
    state.timerMode = 'manual';
    const first = makeLink('https://a.example.com');
    first.focusVisible = true;
    fireDoc('focusin', { target: first });
    runTimers();
    expect(visibleNow()).toBe(true);
    const second = makeLink('https://b.example.com');
    second.focusVisible = true;
    fireDoc('focusin', { target: second });
    expect(visibleNow()).toBe(false);
    expect(bubble().getAttribute('inert')).toBe('');
    const event = stubEvent(second, { key: 'Tab', shiftKey: false });
    fireDoc('keydown', event);
    expect(event.defaultPrevented).toBe(true);
    expect(visibleNow()).toBe(true);
    const text = bubble().children[0] as StubEl;
    const rendered = text.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    expect(rendered).toBe('https://b.example.com/');
    expect(actionButtons()[0]!.focused).toBe(true);
  });

  it('cancels a PENDING show when a menu opens during the delay', async () => {
    state.timerMode = 'manual';
    hoverLink('https://example.com');
    const before = state.clearCount;
    openMenuCount.value += 1;
    await nextTick();
    expect(state.clearCount).toBeGreaterThan(before);
    expect(timers.size).toBe(0);
    openMenuCount.value -= 1;
    await nextTick();
    expect(visibleNow()).toBe(false);
  });

  it('hides a SHOWN bubble when a dialog or sheet opens', async () => {
    hoverLink('https://example.com');
    expect(visibleNow()).toBe(true);
    openDialogCount.value += 1;
    await nextTick();
    expect(visibleNow()).toBe(false);
    expect(bubble().getAttribute('inert')).toBe('');
    openDialogCount.value -= 1;
    await nextTick();
    hoverLink('https://example.com');
    expect(visibleNow()).toBe(true);
    openSheetCount.value += 1;
    await nextTick();
    expect(visibleNow()).toBe(false);
    openSheetCount.value -= 1;
    await nextTick();
  });

  it('cancels a PENDING show on resize during the delay', () => {
    state.timerMode = 'manual';
    hoverLink('https://example.com');
    expect(timers.size).toBe(1);
    winListeners.get('resize')![0]!();
    expect(timers.size).toBe(0);
    expect(visibleNow()).toBe(false);
  });

  it('does not register scroll dismissal for pending or shown bubbles', () => {
    state.timerMode = 'manual';
    hoverLink('https://example.com');
    expect(timers.size).toBe(1);
    expect(winListeners.get('scroll')).toBeUndefined();
    runTimers();
    expect(visibleNow()).toBe(true);
    expect(winListeners.get('scroll')).toBeUndefined();
  });

  it('closes the bubble when the anchor is removed (streaming rebuild)', () => {
    const link = hoverLink('https://example.com');
    expect(visibleNow()).toBe(true);
    link.isConnected = false;
    syncLinkTooltipWithAnchor();
    expect(visibleNow()).toBe(false);
  });

  it('refreshes the bubble when the renderer rewrites the anchor href in place', () => {
    const link = hoverLink('https://example.com/old');
    expect(visibleNow()).toBe(true);
    link.setAttribute('href', 'https://sub.example.org/new');
    syncLinkTooltipWithAnchor();
    expect(visibleNow()).toBe(true);
    const text = bubble().children[0] as StubEl;
    const rendered = text.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    expect(rendered).toBe('https://sub.example.org/new');
    const domain = text.children.find((c): c is StubEl => typeof c !== 'string' && c.tag === 'B') as StubEl;
    expect(domain.textContent).toBe('example.org');
  });

  it('restores focus to the same action after an in-place href rebuild', () => {
    const link = hoverLink('https://example.com/old');
    expect(visibleNow()).toBe(true);
    const buttons = actionButtons();
    (document as unknown as { activeElement: StubEl | null }).activeElement = buttons[1]!;
    link.setAttribute('href', 'https://example.com/new');
    syncLinkTooltipWithAnchor();
    expect(visibleNow()).toBe(true);
    const rebuilt = actionButtons();
    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0]).not.toBe(buttons[0]);
    expect(rebuilt[1]!.focused).toBe(true);
    (document as unknown as { activeElement: StubEl | null }).activeElement = null;
  });

  it('closes the bubble when the anchor stops being an external link', () => {
    const link = hoverLink('https://example.com/old');
    expect(visibleNow()).toBe(true);
    link.setAttribute('href', '/relative/path');
    syncLinkTooltipWithAnchor();
    expect(visibleNow()).toBe(false);
  });

  it('repositions the visible bubble when the anchor moves without an href change', () => {
    const link = hoverLink('https://example.com/x');
    expect(visibleNow()).toBe(true);
    const before = { top: bubble().style.top, left: bubble().style.left };
    link.rect = { top: 300, left: 400, width: 40, height: 16, bottom: 316, right: 440 };
    syncLinkTooltipWithAnchor();
    expect(visibleNow()).toBe(true);
    expect(bubble().style.top).not.toBe(before.top);
    const text = bubble().children[0] as StubEl;
    const rendered = text.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    expect(rendered).toBe('https://example.com/x');
  });

  it('on unmount, closes only tips anchored in the unmounting instance (shared singleton)', () => {
    const link = hoverLink('https://example.com');
    expect(visibleNow()).toBe(true);

    const otherRoot = new StubEl();
    hideLinkTooltipIfAnchorWithin(otherRoot);
    expect(visibleNow()).toBe(true);

    const owningRoot = new StubEl();
    owningRoot.appendChild(link);
    hideLinkTooltipIfAnchorWithin(owningRoot);
    expect(visibleNow()).toBe(false);
  });

  it('keeps the hidden bubble out of the a11y tree (aria-hidden flips with visibility)', () => {
    expect(bubble().getAttribute('aria-hidden')).toBe('true');
    hoverLink('https://example.com');
    expect(bubble().getAttribute('aria-hidden')).toBe('false');
    leave();
    expect(bubble().getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the hidden bubble and its buttons out of the tab order (inert flips with visibility)', () => {
    expect(bubble().getAttribute('inert')).toBe('');
    hoverLink('https://example.com');
    expect(bubble().getAttribute('inert')).toBeNull();
    leave();
    expect(bubble().getAttribute('inert')).toBe('');
  });

  it('shows the tip on keyboard focus (:focus-visible)', () => {
    const link = makeLink('https://example.com');
    link.focusVisible = true;
    fireDoc('focusin', { target: link });
    expect(visibleNow()).toBe(true);
    fireDoc('focusout', { target: link });
    runTimers();
    expect(visibleNow()).toBe(false);
  });

  it('ignores programmatic or mouse-driven focus (no :focus-visible)', () => {
    const link = makeLink('https://example.com');
    fireDoc('focusin', { target: link });
    expect(visibleNow()).toBe(false);
  });

  it('renders both action buttons as icon plus short text label', () => {
    hoverLink('https://example.com/x');
    const buttons = actionButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.className).toBe('md-link-tip-action');
    expect(buttons[0]!.innerHTML).toContain('<svg');
    const labels = buttons.map((button) => {
      const span = button.children.find(
        (c): c is StubEl => typeof c !== 'string' && c.className === 'md-link-tip-action-label',
      );
      return span?.textContent;
    });
    expect(labels).toEqual(['External', 'Sidebar']);
    expect(buttons[0]!.getAttribute('aria-label')).toBeNull();
    expect(buttons[0]!.getAttribute('data-md-tip')).toBeNull();
  });

  it('hides the sidebar button when the host provides no sidebar action (web)', () => {
    ensureLinkTooltip({
      openExternalLabel: () => 'External',
      openInSidebarLabel: () => 'Sidebar',
    });
    hoverLink('https://example.com/x');
    const buttons = actionButtons();
    expect(buttons).toHaveLength(1);
    const span = buttons[0]!.children.find(
      (c): c is StubEl => typeof c !== 'string' && c.className === 'md-link-tip-action-label',
    ) as StubEl;
    expect(span.textContent).toBe('External');
  });

  it('hides the sidebar button when the resolver reports the action unavailable (no bridge)', () => {
    ensureLinkTooltip({
      openExternalLabel: () => 'External',
      openInSidebarLabel: () => 'Sidebar',
      resolveOpenInSidebar: () => undefined,
    });
    hoverLink('https://example.com/x');
    expect(actionButtons()).toHaveLength(1);
  });

  it('external action opens the URL in a new noopener tab and hides', () => {
    const link = hoverLink('https://example.com/x');
    const button = actionButtons()[0]!;
    const event = stubEvent(button);
    button.dispatch('click', event);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
    expect(state.opened).toEqual([{ url: 'https://example.com/x', target: '_blank', features: 'noopener' }]);
    expect(visibleNow()).toBe(false);
    expect(link.getAttribute('aria-describedby')).toBeNull();
  });

  it('sidebar action routes the URL to the host and hides', () => {
    hoverLink('https://example.com/y');
    const button = actionButtons()[1]!;
    button.dispatch('click', stubEvent(button));
    expect(state.opened).toEqual([]);
    expect(state.sidebarOpened).toEqual(['https://example.com/y']);
    expect(visibleNow()).toBe(false);
  });

  it('click outside the bubble hides; click inside does not', () => {
    hoverLink('https://example.com');
    expect(visibleNow()).toBe(true);
    const button = actionButtons()[0]!;
    fireDoc('click', stubEvent(button) as never);
    expect(visibleNow()).toBe(true);
    fireDoc('click', stubEvent(new StubEl()) as never);
    expect(visibleNow()).toBe(false);
  });

  it('keyboard activation of the link hides the bubble (no pointerdown)', () => {
    const link = hoverLink('https://example.com');
    expect(visibleNow()).toBe(true);
    fireDoc('click', stubEvent(link) as never);
    expect(visibleNow()).toBe(false);
  });

  it('keeps the bubble while the pointer crosses the anchor-bubble gap', () => {
    state.timerMode = 'manual';
    hoverLink('https://example.com');
    runTimers();
    expect(visibleNow()).toBe(true);
    leave();
    expect(timers.size).toBe(1);
    firePointerMove(new StubEl(), { x: 110, y: 110 });
    runTimers();
    expect(visibleNow()).toBe(true);
    firePointerMove(new StubEl(), { x: 600, y: 600 });
    runTimers();
    expect(visibleNow()).toBe(false);
  });

  it('stays open while hovering the bubble itself, hides after leaving it', () => {
    state.timerMode = 'manual';
    hoverLink('https://example.com');
    runTimers();
    leave();
    bubble().dispatch('mouseenter', stubEvent(bubble()));
    runTimers();
    expect(visibleNow()).toBe(true);
    bubble().dispatch('mouseleave', stubEvent(bubble()));
    runTimers();
    expect(visibleNow()).toBe(false);
  });

  it('keeps the bubble open while one of its buttons holds focus', () => {
    state.timerMode = 'manual';
    hoverLink('https://example.com');
    runTimers();
    const button = actionButtons()[0]!;
    (document as unknown as { activeElement: StubEl | null }).activeElement = button;
    firePointerMove(new StubEl(), { x: 600, y: 600 });
    expect(timers.size).toBe(1);
    runTimers();
    expect(visibleNow()).toBe(true);
    (document as unknown as { activeElement: StubEl | null }).activeElement = null;
    bubble().dispatch('focusout', stubEvent(bubble(), { relatedTarget: null }));
    runTimers();
    expect(visibleNow()).toBe(false);
  });

  it('does not retarget the bubble to a hovered link while its actions hold focus', () => {
    state.timerMode = 'manual';
    hoverLink('https://a.example.com');
    runTimers();
    expect(visibleNow()).toBe(true);
    const button = actionButtons()[0]!;
    (document as unknown as { activeElement: StubEl | null }).activeElement = button;
    const other = makeLink('https://b.example.com');
    firePointerMove(other);
    expect(visibleNow()).toBe(true);
    const text = bubble().children[0] as StubEl;
    const rendered = text.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    expect(rendered).toBe('https://a.example.com/');
    (document as unknown as { activeElement: StubEl | null }).activeElement = null;
  });

  it('Tab moves focus from the anchor into the bubble buttons', () => {
    const link = hoverLink('https://example.com');
    expect(visibleNow()).toBe(true);
    const event = stubEvent(link, { key: 'Tab', shiftKey: false });
    fireDoc('keydown', event as never);
    expect(event.defaultPrevented).toBe(true);
    expect(actionButtons()[0]!.focused).toBe(true);
  });

  it('Tab during the show delay reveals the actions immediately and focuses the first one', () => {
    state.timerMode = 'manual';
    const link = makeLink('https://example.com');
    link.focusVisible = true;
    fireDoc('focusin', { target: link });
    expect(visibleNow()).toBe(false);
    expect(timers.size).toBe(1);
    const event = stubEvent(link, { key: 'Tab', shiftKey: false });
    fireDoc('keydown', event as never);
    expect(event.defaultPrevented).toBe(true);
    expect(visibleNow()).toBe(true);
    expect(actionButtons()[0]!.focused).toBe(true);
  });

  it('Tab past the last bubble button returns focus to the anchor and hides', () => {
    const link = hoverLink('https://example.com');
    const last = actionButtons().at(-1)!;
    const event = stubEvent(last, { key: 'Tab', shiftKey: false });
    fireDoc('keydown', event as never);
    expect(event.defaultPrevented).toBe(true);
    expect(link.focused).toBe(true);
    expect(visibleNow()).toBe(false);
  });

  it('Escape from inside the bubble returns focus to the anchor and hides', () => {
    const link = hoverLink('https://example.com');
    const button = actionButtons()[0]!;
    const event = stubEvent(button, { key: 'Escape' });
    fireDoc('keydown', event as never);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
    expect(link.focused).toBe(true);
    expect(visibleNow()).toBe(false);
  });

  it('Escape with focus outside a hover-visible bubble closes it but propagates', () => {
    const composer = new StubEl('textarea');
    hoverLink('https://example.com');
    expect(visibleNow()).toBe(true);
    const event = stubEvent(composer, { key: 'Escape' });
    fireDoc('keydown', event as never);
    expect(visibleNow()).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(event.propagationStopped).toBe(false);
  });

  it('does not consume Escape during IME composition', () => {
    const button = actionButtons()[0]!;
    hoverLink('https://example.com');
    expect(visibleNow()).toBe(true);
    const composing = stubEvent(button, { key: 'Escape', isComposing: true });
    fireDoc('keydown', composing as never);
    expect(composing.defaultPrevented).toBe(false);
    expect(composing.propagationStopped).toBe(false);
    expect(visibleNow()).toBe(true);
    const keyProcess = stubEvent(button, { key: 'Escape', keyCode: 229 });
    fireDoc('keydown', keyProcess as never);
    expect(keyProcess.defaultPrevented).toBe(false);
    expect(visibleNow()).toBe(true);
  });
});
