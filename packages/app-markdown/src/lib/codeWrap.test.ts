import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyCodeBlockState,
  CODE_BLOCK_UNSAFE_CSS,
  CODE_NUMS_CLASS,
  CODE_NUMS_TOGGLE_CLASS,
  CODE_WRAP_CLASS,
  CODE_WRAP_TOGGLE_CLASS,
  diffWrapKeys,
  ensureCodeBlockToggles,
  ensureCodeCopyTooltip,
  pruneWrapKeys,
  toggleCodeNums,
  toggleCodeWrap,
  toggleWrapIndex,
} from './codeWrap';
import { nextTick } from 'vue';
import { openMenuCount } from '@moonshot-ai/app-ui';
import {
  CODE_TIP_ATTR,
  ensureCodeTooltip,
  hideCodeTooltipIfAnchorGone,
  hideCodeTooltipIfAnchorWithin,
} from './codeTooltip';

// Node has no DOM — these tests run against a minimal element stub that
// implements exactly the surface codeWrap.ts uses (classList, recursive
// querySelector over class/tag selectors + the anchor selector with its
// :not() exclusions, insertBefore/appendChild, innerHTML, attributes, click
// events, and an optional shadowRoot for the pierre pre).
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
  toString(): string {
    return [...this.tokens].join(' ');
  }
}

interface StubEvent {
  type: string;
  prevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

class StubElement {
  classList = new StubClassList();
  children: StubElement[] = [];
  parentElement: StubElement | null = null;
  type = '';
  disabled = false;
  tag = 'div';
  shadowRoot: StubElement | null = null;
  shadowPre: StubElement | null = null;
  /** Number of innerHTML writes — stands in for childList mutations. */
  htmlSetCount = 0;
  /** Number of setAttribute calls — stands in for attribute mutations. */
  attrSetCount = 0;
  private html = '';
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<(event: StubEvent) => void>>();

  set className(value: string) {
    this.classList.setFromString(value);
  }
  get className(): string {
    return this.classList.toString();
  }
  set innerHTML(value: string) {
    this.html = value;
    this.htmlSetCount += 1;
  }
  get innerHTML(): string {
    return this.html;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    this.attrSetCount += 1;
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  appendChild<T extends StubElement>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore<T extends StubElement>(child: T, ref: StubElement): T {
    child.parentElement = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(child);
    else this.children.splice(i, 0, child);
    return child;
  }
  addEventListener(type: string, fn: (event: StubEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  click(): void {
    const event: StubEvent = {
      type: 'click',
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

  private findByClass(cls: string, skipDisabled: boolean): StubElement | null {
    for (const child of this.children) {
      if (child.classList.contains(cls) && !(skipDisabled && child.disabled)) return child;
      const nested = child.findByClass(cls, skipDisabled);
      if (nested) return nested;
    }
    return null;
  }
  private findByTag(tag: string): StubElement | null {
    for (const child of this.children) {
      if (child.tag === tag) return child;
      const nested = child.findByTag(tag);
      if (nested) return nested;
    }
    return null;
  }
  private findActionAnchor(): StubElement | null {
    for (const child of this.children) {
      if (
        child.classList.contains('code-action-btn') &&
        !child.disabled &&
        !child.classList.contains(CODE_WRAP_TOGGLE_CLASS) &&
        !child.classList.contains(CODE_NUMS_TOGGLE_CLASS)
      ) {
        return child;
      }
      const nested = child.findActionAnchor();
      if (nested) return nested;
    }
    return null;
  }
  querySelector(selector: string): StubElement | null {
    if (
      selector ===
      `.code-block-header .code-action-btn:not([disabled]):not(.${CODE_WRAP_TOGGLE_CLASS}):not(.${CODE_NUMS_TOGGLE_CLASS})`
    ) {
      return this.findActionAnchor();
    }
    if (selector === 'diffs-container') {
      return this.findByTag('diffs-container');
    }
    if (selector === 'pre[data-overflow]') {
      return this.shadowPre;
    }
    if (selector.startsWith('button.')) {
      return this.findByClass(selector.slice('button.'.length), false);
    }
    return this.findByClass(selector.replace(/^\./, ''), false);
  }
}

const LABELS = {
  wrap: 'Enable word wrap',
  unwrap: 'Disable word wrap',
  showNums: 'Show line numbers',
  hideNums: 'Hide line numbers',
  copy: 'Copy code',
};
const ZH_LABELS = {
  wrap: '开启自动换行',
  unwrap: '关闭自动换行',
  showNums: '显示行号',
  hideNums: '隐藏行号',
  copy: '复制代码',
};

function makeContainer(opts: { copyDisabled?: boolean; withPierre?: boolean } = {}) {
  const container = new StubElement();
  const header = container.appendChild(new StubElement());
  header.className = 'code-block-header';
  const row = header.appendChild(new StubElement());
  const copy = row.appendChild(new StubElement());
  copy.tag = 'button';
  copy.className = 'code-action-btn inline-flex items-center';
  copy.disabled = opts.copyDisabled ?? false;
  if (opts.withPierre) {
    const host = container.appendChild(new StubElement());
    host.tag = 'diffs-container';
    const pre = new StubElement();
    pre.setAttribute('data-overflow', 'scroll');
    host.shadowPre = pre;
    host.shadowRoot = host; // querySelector('pre[data-overflow]') → shadowPre
  }
  return {
    container: container as unknown as HTMLElement,
    stub: container,
    copy,
    row,
  };
}

function stubOf(el: HTMLElement): StubElement {
  return el as unknown as StubElement;
}

function wrapToggleOf(container: HTMLElement): StubElement {
  return stubOf(container).querySelector(`button.${CODE_WRAP_TOGGLE_CLASS}`)!;
}

function numsToggleOf(container: HTMLElement): StubElement {
  return stubOf(container).querySelector(`button.${CODE_NUMS_TOGGLE_CLASS}`)!;
}

function pierreHostOf(container: HTMLElement): StubElement {
  return stubOf(container).children.find((c) => c.tag === 'diffs-container')!;
}

// Stands in for the real MutationObserver: codeWrap attaches one per pierre
// host to replay toggle state after the shadow pre is rebuilt.
class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  observed: unknown = null;
  options: unknown = null;
  private cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeMutationObserver.instances.push(this);
  }
  observe(target: unknown, options: unknown): void {
    this.observed = target;
    this.options = options;
  }
  disconnect(): void {}
  fire(): void {
    this.cb();
  }
}

beforeEach(() => {
  // ensureCodeBlockToggles calls document.createElement('button').
  (globalThis as Record<string, unknown>).document = {
    createElement: () => new StubElement(),
  };
  FakeMutationObserver.instances = [];
  (globalThis as Record<string, unknown>).MutationObserver = FakeMutationObserver;
});

describe('ensureCodeBlockToggles', () => {
  it('inserts numbers + wrap toggles before the copy button, in order, copying its class list', () => {
    const { container, row, copy } = makeContainer({ withPierre: true });
    const button = ensureCodeBlockToggles(container, LABELS)!;
    const kinds = row.children.map((k) =>
      k === copy
        ? 'copy'
        : k.classList.contains(CODE_NUMS_TOGGLE_CLASS)
          ? 'nums'
          : 'wrap',
    );
    expect(kinds).toEqual(['nums', 'wrap', 'copy']);
    expect(stubOf(button).classList.contains('code-action-btn')).toBe(true);
    expect(stubOf(button).classList.contains(CODE_WRAP_TOGGLE_CLASS)).toBe(true);
    expect(stubOf(button).type).toBe('button');
    expect(stubOf(button).getAttribute('aria-label')).toBe(LABELS.wrap);
    expect(stubOf(button).getAttribute('aria-pressed')).toBe('false');
    expect(stubOf(button).getAttribute(CODE_TIP_ATTR)).toBe(LABELS.wrap);
    const nums = numsToggleOf(container);
    expect(nums.classList.contains('code-action-btn')).toBe(true);
    expect(nums.getAttribute('aria-label')).toBe(LABELS.showNums);
    expect(nums.getAttribute('aria-pressed')).toBe('false');
    expect(nums.getAttribute(CODE_TIP_ATTR)).toBe(LABELS.showNums);
    // The copy button gets its localized native title in the same pass.
    expect(copy.getAttribute(CODE_TIP_ATTR)).toBe(LABELS.copy);
  });

  it('is idempotent and does not duplicate either toggle', () => {
    const { container } = makeContainer({ withPierre: true });
    const first = ensureCodeBlockToggles(container, LABELS)!;
    expect(ensureCodeBlockToggles(container, LABELS)).toBe(first);
    expect(stubOf(container).querySelector(`.${CODE_WRAP_TOGGLE_CLASS}`)).toBe(stubOf(first));
    const nums = numsToggleOf(container);
    ensureCodeBlockToggles(container, LABELS);
    expect(numsToggleOf(container)).toBe(nums);
  });

  it('skips injection while only disabled (placeholder) action buttons exist', () => {
    const { container } = makeContainer({ copyDisabled: true });
    expect(ensureCodeBlockToggles(container, LABELS)).toBeNull();
    expect(stubOf(container).querySelector(`.${CODE_WRAP_TOGGLE_CLASS}`)).toBeNull();
    expect(stubOf(container).querySelector(`.${CODE_NUMS_TOGGLE_CLASS}`)).toBeNull();
  });

  it('does NOT inject the numbers toggle without a pierre host (plain-pre path), but keeps wrap + copy hint', () => {
    // Heavy plain-pre blocks (markdownPerformance downgrade) have no
    // per-line DOM to number — a numbers toggle there would be a no-op.
    const { container, copy } = makeContainer();
    ensureCodeBlockToggles(container, LABELS);
    expect(stubOf(container).querySelector(`.${CODE_NUMS_TOGGLE_CLASS}`)).toBeNull();
    expect(stubOf(container).querySelector(`.${CODE_WRAP_TOGGLE_CLASS}`)).not.toBeNull();
    expect(copy.getAttribute(CODE_TIP_ATTR)).toBe(LABELS.copy);
  });

  it('injects the numbers toggle once the pierre host appears (fallback → highlighted swap)', () => {
    const { container, stub } = makeContainer();
    ensureCodeBlockToggles(container, LABELS);
    expect(stubOf(container).querySelector(`.${CODE_NUMS_TOGGLE_CLASS}`)).toBeNull();
    // The highlighted block mounts its shadow renderer a pass later.
    const host = stub.appendChild(new StubElement());
    host.tag = 'diffs-container';
    ensureCodeBlockToggles(container, LABELS);
    expect(stubOf(container).querySelector(`.${CODE_NUMS_TOGGLE_CLASS}`)).not.toBeNull();
  });
});

describe('toggleCodeWrap', () => {
  it('toggles the wrap class, icon, label and pressed state on click', () => {
    const { container } = makeContainer();
    ensureCodeBlockToggles(container, LABELS);
    const button = wrapToggleOf(container);

    button.click();
    expect(stubOf(container).classList.contains(CODE_WRAP_CLASS)).toBe(true);
    expect(button.getAttribute('aria-label')).toBe(LABELS.unwrap);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute(CODE_TIP_ATTR)).toBe(LABELS.unwrap);
    expect(button.innerHTML).toContain('M4 6h10'); // text-wrap-disabled

    button.click();
    expect(stubOf(container).classList.contains(CODE_WRAP_CLASS)).toBe(false);
    expect(button.getAttribute('aria-label')).toBe(LABELS.wrap);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.innerHTML).toContain('M4 6h16'); // text-wrap
  });

  it('works without an injected toggle (class-only state flip)', () => {
    const { container } = makeContainer();
    toggleCodeWrap(container, LABELS);
    expect(stubOf(container).classList.contains(CODE_WRAP_CLASS)).toBe(true);
  });
});

describe('toggleCodeNums', () => {
  it('toggles the numbers class, label and pressed state on click, independently of wrap', () => {
    const { container } = makeContainer({ withPierre: true });
    ensureCodeBlockToggles(container, LABELS);
    const button = numsToggleOf(container);

    button.click();
    expect(stubOf(container).classList.contains(CODE_NUMS_CLASS)).toBe(true);
    expect(stubOf(container).classList.contains(CODE_WRAP_CLASS)).toBe(false);
    expect(button.getAttribute('aria-label')).toBe(LABELS.hideNums);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute(CODE_TIP_ATTR)).toBe(LABELS.hideNums);
    expect(button.innerHTML).toContain('M11 6h9'); // list-numbers

    button.click();
    expect(stubOf(container).classList.contains(CODE_NUMS_CLASS)).toBe(false);
    expect(button.getAttribute('aria-label')).toBe(LABELS.showNums);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('works without an injected toggle (class-only state flip)', () => {
    const { container } = makeContainer();
    toggleCodeNums(container, LABELS);
    expect(stubOf(container).classList.contains(CODE_NUMS_CLASS)).toBe(true);
  });
});

describe('applyCodeBlockState', () => {
  it('flips the pierre shadow pre data-overflow with the wrap class', () => {
    const { container } = makeContainer({ withPierre: true });
    const host = pierreHostOf(container);

    ensureCodeBlockToggles(container, LABELS);
    wrapToggleOf(container).click(); // wrap on
    expect(host.shadowPre!.getAttribute('data-overflow')).toBe('wrap');

    wrapToggleOf(container).click(); // wrap off
    expect(host.shadowPre!.getAttribute('data-overflow')).toBe('scroll');
  });

  it('writes data-md-nums with the numbers class, independent of wrap', () => {
    const { container } = makeContainer({ withPierre: true });
    const host = pierreHostOf(container);

    ensureCodeBlockToggles(container, LABELS);
    numsToggleOf(container).click(); // numbers on, still scroll mode
    expect(host.shadowPre!.getAttribute('data-md-nums')).toBe('on');
    expect(host.shadowPre!.getAttribute('data-overflow')).toBe('scroll');

    toggleCodeWrap(container, LABELS); // wrap on too — numbers stay
    expect(host.shadowPre!.getAttribute('data-md-nums')).toBe('on');
    expect(host.shadowPre!.getAttribute('data-overflow')).toBe('wrap');

    numsToggleOf(container).click(); // numbers off, wrap stays
    expect(host.shadowPre!.getAttribute('data-md-nums')).toBe('off');
    expect(host.shadowPre!.getAttribute('data-overflow')).toBe('wrap');
  });

  it('re-applies both attributes on ensure when the shadow pre was recreated', () => {
    const { container } = makeContainer({ withPierre: true });
    const host = pierreHostOf(container);
    ensureCodeBlockToggles(container, LABELS);
    toggleCodeWrap(container, LABELS); // wrap on
    toggleCodeNums(container, LABELS); // numbers on

    // pierre re-renders its shadow content: a fresh pre back to stock attrs.
    const fresh = new StubElement();
    fresh.setAttribute('data-overflow', 'scroll');
    host.shadowPre = fresh;
    applyCodeBlockState(container);
    expect(fresh.getAttribute('data-overflow')).toBe('wrap');
    expect(fresh.getAttribute('data-md-nums')).toBe('on');
  });

  it('no-ops when the block has no shadow renderer mounted', () => {
    const { container } = makeContainer();
    toggleCodeWrap(container, LABELS);
    expect(() => applyCodeBlockState(container)).not.toThrow();
    expect(stubOf(container).classList.contains(CODE_WRAP_CLASS)).toBe(true);
  });
});

describe('locale switch (re-ensure with new labels)', () => {
  it('refreshes title/aria-label on already-injected toggles', () => {
    const { container } = makeContainer({ withPierre: true });
    ensureCodeBlockToggles(container, LABELS);
    const wrap = wrapToggleOf(container);
    const nums = numsToggleOf(container);

    ensureCodeBlockToggles(container, ZH_LABELS);
    expect(wrap.getAttribute('aria-label')).toBe(ZH_LABELS.wrap);
    expect(wrap.getAttribute(CODE_TIP_ATTR)).toBe(ZH_LABELS.wrap);
    expect(nums.getAttribute('aria-label')).toBe(ZH_LABELS.showNums);
    expect(nums.getAttribute(CODE_TIP_ATTR)).toBe(ZH_LABELS.showNums);
    // Still off.
    expect(wrap.getAttribute('aria-pressed')).toBe('false');
    expect(nums.getAttribute('aria-pressed')).toBe('false');
  });

  it('the click handler uses the latest labels, not the injection-time ones', () => {
    const { container } = makeContainer({ withPierre: true });
    ensureCodeBlockToggles(container, LABELS);
    ensureCodeBlockToggles(container, ZH_LABELS); // locale switched to zh

    wrapToggleOf(container).click(); // wrap on
    const wrap = wrapToggleOf(container);
    expect(wrap.getAttribute('aria-label')).toBe(ZH_LABELS.unwrap);
    expect(wrap.getAttribute(CODE_TIP_ATTR)).toBe(ZH_LABELS.unwrap);

    numsToggleOf(container).click(); // numbers on
    const nums = numsToggleOf(container);
    expect(nums.getAttribute('aria-label')).toBe(ZH_LABELS.hideNums);

    ensureCodeBlockToggles(container, LABELS); // locale switched back to en
    expect(wrap.getAttribute('aria-label')).toBe(LABELS.unwrap);
    expect(nums.getAttribute('aria-label')).toBe(LABELS.hideNums);
  });

  it('refreshes the copy button tooltip attribute on locale switch', () => {
    const { container, copy } = makeContainer({ withPierre: true });
    ensureCodeBlockToggles(container, LABELS);
    expect(copy.getAttribute(CODE_TIP_ATTR)).toBe(LABELS.copy);

    ensureCodeBlockToggles(container, ZH_LABELS);
    expect(copy.getAttribute(CODE_TIP_ATTR)).toBe(ZH_LABELS.copy);
    // The injected toggles keep their own labels — the copy pass must not
    // land on them (they share the code-action-btn class with the anchor).
    expect(wrapToggleOf(container).getAttribute(CODE_TIP_ATTR)).toBe(ZH_LABELS.wrap);
    expect(numsToggleOf(container).getAttribute(CODE_TIP_ATTR)).toBe(ZH_LABELS.showNums);
  });
});

describe('toggleWrapIndex (local diff renderer state)', () => {
  it('flips one index independently of the others', () => {
    const wrapped = new Set<number>();
    expect(toggleWrapIndex(wrapped, 2)).toBe(true);
    expect(wrapped.has(2)).toBe(true);

    expect(toggleWrapIndex(wrapped, 0)).toBe(true);
    expect([...wrapped].sort((a, b) => a - b)).toEqual([0, 2]);

    expect(toggleWrapIndex(wrapped, 2)).toBe(false);
    expect(wrapped.has(2)).toBe(false);
    expect(wrapped.has(0)).toBe(true);
  });
});

describe('mutation-free re-ensure (MutationObserver loop guard)', () => {
  it('repeated ensure with unchanged state writes nothing', () => {
    const { container } = makeContainer({ withPierre: true });
    ensureCodeBlockToggles(container, LABELS);
    const wrap = wrapToggleOf(container);
    const nums = numsToggleOf(container);
    const wrapAfterInject = wrap.htmlSetCount;
    const numsAfterInject = nums.htmlSetCount;

    ensureCodeBlockToggles(container, LABELS);
    ensureCodeBlockToggles(container, LABELS);
    ensureCodeBlockToggles(container, LABELS);
    expect(wrap.htmlSetCount).toBe(wrapAfterInject);
    expect(nums.htmlSetCount).toBe(numsAfterInject);
  });

  it('writes exactly once per real change (label switch, state toggle)', () => {
    const { container } = makeContainer();
    ensureCodeBlockToggles(container, LABELS);
    const button = wrapToggleOf(container);

    let n = button.htmlSetCount;
    ensureCodeBlockToggles(container, ZH_LABELS);
    expect(button.htmlSetCount).toBe(n + 1);

    n = button.htmlSetCount;
    toggleCodeWrap(container, LABELS);
    expect(button.htmlSetCount).toBe(n + 1);

    // …and stays quiet again afterwards.
    n = button.htmlSetCount;
    ensureCodeBlockToggles(container, LABELS);
    expect(button.htmlSetCount).toBe(n);
  });
});

describe('shadow pre rebuild replay', () => {
  it('replays wrap + numbers state when pierre rebuilds the shadow pre', () => {
    const { container } = makeContainer({ withPierre: true });
    ensureCodeBlockToggles(container, LABELS);
    toggleCodeWrap(container, LABELS); // wrap on
    toggleCodeNums(container, LABELS); // numbers on
    const host = pierreHostOf(container);
    expect(host.shadowPre!.getAttribute('data-overflow')).toBe('wrap');
    expect(host.shadowPre!.getAttribute('data-md-nums')).toBe('on');

    // pierre rebuilds its shadow content (async highlight, theme update):
    // a fresh pre comes back with stock attributes.
    const fresh = new StubElement();
    fresh.setAttribute('data-overflow', 'scroll');
    host.shadowPre = fresh;

    const watcher = FakeMutationObserver.instances.find((o) => o.observed === host.shadowRoot);
    expect(watcher).toBeTruthy();
    watcher!.fire();
    expect(fresh.getAttribute('data-overflow')).toBe('wrap');
    expect(fresh.getAttribute('data-md-nums')).toBe('on');
  });

  it('attaches one watcher per host and writes only on a real mismatch', () => {
    const { container } = makeContainer({ withPierre: true });
    const host = pierreHostOf(container);
    ensureCodeBlockToggles(container, LABELS);
    ensureCodeBlockToggles(container, LABELS); // no second watcher
    expect(FakeMutationObserver.instances).toHaveLength(1);

    // All state off + pre already matching → no attribute writes at all.
    host.shadowPre!.attrSetCount = 0;
    applyCodeBlockState(container);
    expect(host.shadowPre!.attrSetCount).toBe(0);

    // Toggle on → exactly one write; a redundant replay adds none.
    toggleCodeWrap(container, LABELS);
    expect(host.shadowPre!.attrSetCount).toBe(1);
    applyCodeBlockState(container);
    expect(host.shadowPre!.attrSetCount).toBe(1);

    // …and the watcher callback itself is write-free once state matches,
    // so it cannot loop (shadow setAttribute re-triggers the watcher).
    const watcher = FakeMutationObserver.instances[0]!;
    watcher.fire();
    expect(host.shadowPre!.attrSetCount).toBe(1);
  });
});

describe('diffWrapKeys (per-occurrence content keys)', () => {
  it('gives identical-content blocks independent keys, so toggles stay per block', () => {
    const keys = diffWrapKeys(['a', 'b', 'a']);
    expect(keys).toEqual(['1#a', '1#b', '2#a']);

    const wrapped = new Set<string>();
    toggleWrapIndex(wrapped, keys[0]!);
    expect(wrapped.has(keys[0]!)).toBe(true);
    expect(wrapped.has(keys[2]!)).toBe(false); // the identical twin is untouched
  });

  it('keys follow their block across insertion / removal / reordering', () => {
    const before = diffWrapKeys(['a', 'b', 'a']);
    // New content inserts a block before and drops another: each block's
    // occurrence-among-identical-code order is preserved, so its key (and
    // therefore its wrap state) travels with it.
    const after = diffWrapKeys(['c', 'a', 'a']);
    expect(after[1]).toBe(before[0]); // the first 'a' block keeps its key
    expect(after[2]).toBe(before[2]); // the second 'a' block keeps its key
  });

  it('is stable within a streaming growth sequence (same render, same keys)', () => {
    // Mid-stream the last block's code grows chunk by chunk; its key changes
    // with the content (state for THAT block resets, as with plain content
    // keys), but every other block's key must stay put.
    const t1 = diffWrapKeys(['done-1', 'partial']);
    const t2 = diffWrapKeys(['done-1', 'partial-longer']);
    expect(t2[0]).toBe(t1[0]);
  });
});

describe('pruneWrapKeys (stale key cleanup)', () => {
  it('drops keys whose block no longer exists and keeps live ones', () => {
    const wrapped = new Set(['1#a', '1#deleted', '2#a']);
    // The '1#deleted' block is gone from the render; the 'a' twins survive.
    pruneWrapKeys(wrapped, diffWrapKeys(['a', 'b', 'a']));
    expect([...wrapped].sort()).toEqual(['1#a', '2#a']);
  });

  it('drops keys orphaned by a code edit (the key changes with the content)', () => {
    const wrapped = new Set(diffWrapKeys(['before']));
    pruneWrapKeys(wrapped, diffWrapKeys(['after']));
    expect(wrapped.size).toBe(0);
  });

  it('is a no-op when every key is still live, and tolerates an empty set', () => {
    const wrapped = new Set(['1#a']);
    pruneWrapKeys(wrapped, ['1#a', '1#b']);
    expect([...wrapped]).toEqual(['1#a']);

    const empty = new Set<string>();
    pruneWrapKeys(empty, ['1#a']);
    expect(empty.size).toBe(0);
  });
});

describe('ensureCodeCopyTooltip (streaming-phase copy tooltip)', () => {
  it('stamps the copy tooltip attribute WITHOUT injecting the toggles (the streaming path)', () => {
    const { container, copy } = makeContainer();
    ensureCodeCopyTooltip(container, '复制代码');
    expect(copy.getAttribute(CODE_TIP_ATTR)).toBe('复制代码');
    // The toggles themselves still wait for the turn to settle.
    expect(stubOf(container).querySelector(`.${CODE_WRAP_TOGGLE_CLASS}`)).toBeNull();
    expect(stubOf(container).querySelector(`.${CODE_NUMS_TOGGLE_CLASS}`)).toBeNull();
  });

  it('is idempotent per label and refreshes on locale switch', () => {
    const { container, copy } = makeContainer();
    ensureCodeCopyTooltip(container, LABELS.copy);
    expect(copy.attrSetCount).toBe(1);

    ensureCodeCopyTooltip(container, LABELS.copy); // same label → no write
    expect(copy.attrSetCount).toBe(1);

    ensureCodeCopyTooltip(container, '复制代码'); // locale switch → one write
    expect(copy.attrSetCount).toBe(2);
    expect(copy.getAttribute(CODE_TIP_ATTR)).toBe('复制代码');
  });

  it('no-ops while only disabled (placeholder) action buttons exist', () => {
    const { container, copy } = makeContainer({ copyDisabled: true });
    ensureCodeCopyTooltip(container, LABELS.copy);
    expect(copy.getAttribute(CODE_TIP_ATTR)).toBeNull();
    expect(copy.attrSetCount).toBe(0);
  });

  it('keeps stamping the copy button after the toggles are injected (anchor exclusion)', () => {
    const { container, copy } = makeContainer({ withPierre: true });
    ensureCodeBlockToggles(container, LABELS); // injects both class twins
    ensureCodeCopyTooltip(container, '复制代码');
    expect(copy.getAttribute(CODE_TIP_ATTR)).toBe('复制代码');
    expect(wrapToggleOf(container).getAttribute(CODE_TIP_ATTR)).toBe(LABELS.wrap); // untouched
    expect(numsToggleOf(container).getAttribute(CODE_TIP_ATTR)).toBe(LABELS.showNums); // untouched
  });
});

describe('CODE_BLOCK_UNSAFE_CSS (pierre host styles)', () => {
  it('gates the line-number counter on the numbers toggle attribute, in both modes', () => {
    expect(CODE_BLOCK_UNSAFE_CSS).toContain('pre[data-md-nums="on"] { counter-reset:');
    expect(CODE_BLOCK_UNSAFE_CSS).toContain('pre[data-md-nums="on"] [data-line] {');
    expect(CODE_BLOCK_UNSAFE_CSS).toContain('counter-increment:');
    expect(CODE_BLOCK_UNSAFE_CSS).toContain('content: counter(');
    // Numbers follow the numbers toggle, NOT the wrap mode: no counter may
    // be gated on data-overflow either way.
    expect(CODE_BLOCK_UNSAFE_CSS).not.toContain('[data-overflow="wrap"] [data-line]::before');
    expect(CODE_BLOCK_UNSAFE_CSS).not.toContain('[data-overflow="scroll"] [data-line]::before');
  });

  it('keeps the shared code-column inset alignment rule', () => {
    expect(CODE_BLOCK_UNSAFE_CSS).toContain('padding-inline: var(--space-3);');
  });

  it('pins the counter box at 3ch so 4+-digit numbers overflow left instead of widening the gutter', () => {
    expect(CODE_BLOCK_UNSAFE_CSS).toContain('width: 3ch;');
    expect(CODE_BLOCK_UNSAFE_CSS).toContain('overflow: visible;');
    expect(CODE_BLOCK_UNSAFE_CSS).toContain('text-align: right;');
  });
});

// --- codeTooltip singleton smoke test ---------------------------------------
// Minimal standalone DOM for the document-level tooltip singleton (kept apart
// from StubElement: the singleton touches document/window directly).
class TipStubEl {
  id = '';
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  offsetWidth = 60;
  offsetHeight = 24;
  isConnected = true;
  classes = new Set<string>();
  attrs = new Map<string, string>();
  classList = {
    add: (c: string): void => {
      this.classes.add(c);
    },
    remove: (c: string): void => {
      this.classes.delete(c);
    },
    contains: (c: string): boolean => this.classes.has(c),
  };
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  children: TipStubEl[] = [];
  appendChild<T extends TipStubEl>(child: T): T {
    this.children.push(child);
    return child;
  }
  contains(el: TipStubEl): boolean {
    return this.children.some((c) => c === el || c.contains(el));
  }
  closest(selector: string): TipStubEl | null {
    if (selector === '[data-md-tip]' && this.attrs.has('data-md-tip')) return this;
    return null;
  }
  getBoundingClientRect(): { top: number; left: number; width: number; height: number; bottom: number; right: number } {
    return { top: 100, left: 100, width: 24, height: 24, bottom: 124, right: 124 };
  }
}

describe('codeTooltip singleton (ensureCodeTooltip)', () => {
  // One shared DOM stub for the whole suite: the singleton is module-stateful
  // (`started` flips on the first ensure), so every test rides the listeners
  // captured here. The timer stub is switchable: 'immediate' runs the show
  // callback synchronously, 'manual' parks it for pending-cancellation tests.
  const docListeners = new Map<string, Array<(event: unknown) => void>>();
  const winListeners = new Map<string, Array<() => void>>();
  const timers = new Map<number, () => void>();
  const state = { timerMode: 'immediate' as 'immediate' | 'manual', clearCount: 0, lastDelay: -1 };
  let nextTimerId = 0;
  const head = {
    appended: [] as TipStubEl[],
    appendChild(child: TipStubEl): TipStubEl {
      this.appended.push(child);
      return child;
    },
  };
  const body = {
    appended: [] as TipStubEl[],
    appendChild(child: TipStubEl): TipStubEl {
      this.appended.push(child);
      return child;
    },
  };

  function bubble(): TipStubEl {
    return body.appended[0]!;
  }
  function visibleNow(): boolean {
    return bubble().classList.contains('md-code-tip--visible');
  }
  function hoverAnchor(text: string): TipStubEl {
    const el = new TipStubEl();
    el.setAttribute(CODE_TIP_ATTR, text);
    docListeners.get('mouseover')![0]!({ target: el });
    return el;
  }
  function leave(): void {
    docListeners.get('mouseout')![0]!({ relatedTarget: null });
  }

  beforeAll(() => {
    (globalThis as Record<string, unknown>).document = {
      createElement: () => new TipStubEl(),
      getElementById: () => null,
      head,
      body,
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
      },
    };
    (globalThis as Record<string, unknown>).Element = TipStubEl;
    (globalThis as Record<string, unknown>).getComputedStyle = () => ({
      // No tokens in node → tokenPx must fall back to the design values.
      getPropertyValue: () => '',
    });
    (globalThis as Record<string, unknown>).window = {
      addEventListener: (type: string, fn: () => void) => {
        winListeners.set(type, [...(winListeners.get(type) ?? []), fn]);
      },
      innerWidth: 1000,
      innerHeight: 800,
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
    ensureCodeTooltip();
  });

  beforeEach(() => {
    leave(); // reset to hidden/pending-free between tests
    timers.clear();
    state.timerMode = 'immediate';
  });

  it('starts once: one stylesheet, one bubble, one listener set', () => {
    ensureCodeTooltip(); // idempotent — a second Markdown mount must not duplicate
    expect(head.appended).toHaveLength(1);
    expect(head.appended[0]!.id).toBe('md-code-tip-style');
    const css = head.appended[0]!.textContent;
    expect(css).toContain('var(--color-text)');
    expect(css).toContain('var(--z-tooltip)');
    // Metrics are token-driven (no hardcoded px/ratio in the recipe).
    expect(css).toContain('max-width: var(--p-tip-max-w);');
    expect(css).toContain('padding: var(--space-1) var(--space-2);');
    expect(css).not.toContain('280px');
    expect(css).not.toContain('4px 8px');
    expect(css).not.toContain('1.35');
    expect(body.appended).toHaveLength(1);
    expect(bubble().getAttribute('role')).toBe('tooltip');
    expect(docListeners.get('mouseover')).toHaveLength(1);
  });

  it('shows the anchor text after the token show delay (150ms fallback) and hides on leave', () => {
    state.timerMode = 'manual';
    hoverAnchor('Enable word wrap');
    expect(state.lastDelay).toBe(150); // --duration-tooltip fallback (no token in node)
    timers.forEach((fn) => fn());
    expect(bubble().textContent).toBe('Enable word wrap');
    expect(visibleNow()).toBe(true);
    leave();
    expect(visibleNow()).toBe(false);
  });

  it('cancels a PENDING show when a menu opens during the delay', async () => {
    state.timerMode = 'manual';
    hoverAnchor('Enable word wrap');
    const before = state.clearCount;
    openMenuCount.value += 1;
    await nextTick();
    expect(state.clearCount).toBeGreaterThan(before); // the pending timer was cleared
    expect(timers.size).toBe(0);
    // …and even if the callback somehow still fires, the fire-time re-check
    // refuses to show over the open menu.
    openMenuCount.value -= 1;
    await nextTick();
    expect(visibleNow()).toBe(false);
  });

  it('cancels a PENDING show on scroll/resize during the delay', () => {
    state.timerMode = 'manual';
    hoverAnchor('Enable word wrap');
    expect(timers.size).toBe(1);
    winListeners.get('scroll')![0]!();
    expect(timers.size).toBe(0);
    expect(visibleNow()).toBe(false);
  });

  it('closes the bubble when the anchor is removed (streaming rebuild)', () => {
    const el = hoverAnchor('Enable word wrap'); // immediate timer → already visible
    expect(visibleNow()).toBe(true);
    el.isConnected = false; // markstream swapped the header without a mouseout
    hideCodeTooltipIfAnchorGone();
    expect(visibleNow()).toBe(false);
  });

  it('on unmount, closes only tips anchored in the unmounting instance (shared singleton)', () => {
    const el = hoverAnchor('Enable word wrap');
    expect(visibleNow()).toBe(true);

    // Another instance's root does not own this anchor — tip survives.
    const otherRoot = new TipStubEl();
    hideCodeTooltipIfAnchorWithin(otherRoot);
    expect(visibleNow()).toBe(true);

    // The owning root (this instance's mdRef) closes it on unmount.
    const owningRoot = new TipStubEl();
    owningRoot.appendChild(el);
    hideCodeTooltipIfAnchorWithin(owningRoot);
    expect(visibleNow()).toBe(false);
  });
});

describe('pressed-state CSS hooks (Markdown.vue style block)', () => {
  // The translucent --color-selected fill must land on the BUTTON alone —
  // painting it on the ` *` descendant variant too stacked a second, darker
  // layer inside the icon (the double-background bug). These assertions pin
  // the selector split so the two rules can't be merged back.
  const vue = readFileSync(new URL('../Markdown.vue', import.meta.url), 'utf8');

  /** Rule body ({...}) whose selector text contains `needle`. */
  function ruleBody(needle: string): string {
    const i = vue.indexOf(needle);
    expect(i, `selector not found: ${needle}`).toBeGreaterThan(-1);
    const open = vue.indexOf('{', i);
    const close = vue.indexOf('}', open);
    return vue.slice(open + 1, close);
  }

  it('paints the pressed fill on the button only', () => {
    const buttonRule = ruleBody(".md-code-wrap-toggle[aria-pressed='true']),");
    expect(buttonRule).toContain('background: var(--color-selected);');
    expect(buttonRule).toContain('color: var(--color-text);');
    const hoverRule = ruleBody(".md-code-wrap-toggle[aria-pressed='true']:hover");
    expect(hoverRule).toContain('background: var(--color-selected-hover);');
  });

  it('descendant variant carries ONLY the ink — background stays transparent', () => {
    const descendantRule = ruleBody(".md-code-wrap-toggle[aria-pressed='true'] *)");
    expect(descendantRule).toContain('background: transparent;');
    expect(descendantRule).toContain('color: var(--color-text);');
    expect(descendantRule).not.toContain('var(--color-selected)');
  });

  it('diff IconButton pressed rule has no descendant variant at all', () => {
    // The diff-bar override targets the primitive's root button only; there
    // is no ` *` rule that could stack the fill inside it.
    expect(vue).not.toContain(".ui-icon-button[aria-pressed='true'] *");
  });

  it('hover carries the ink to icon descendants, but never the background wash', () => {
    // Same blanket-rule workaround as pressed: `.code-block-header *` pins
    // the glyph to muted, so the hover ink needs the descendant variant —
    // while the f1 wash stays on the button alone (no translucent stacking).
    const hoverDescendant = ruleBody('.code-action-btn:hover *)');
    expect(hoverDescendant).toContain('color: var(--color-text);');
    expect(hoverDescendant).not.toContain('background:');
  });

  it('wrapped diff without numbers hangs the sign column so continuations start at the code column', () => {
    const indentRule = ruleBody('.diff-wrap.md-code-wrap:not(.md-code-nums) .diff-line {');
    expect(indentRule).toContain('padding-left: calc(var(--space-3) + var(--diff-sign-col));');
    const signRule = ruleBody('.diff-wrap.md-code-wrap:not(.md-code-nums) .diff-sign {');
    expect(signRule).toContain('margin-left: calc(-1 * var(--diff-sign-col));');
  });

  it('the sign column width is single-sourced via the --diff-sign-col design token (no stray 14px)', () => {
    // The definition lives in the shared token sheet, not in the component.
    const wrapRule = ruleBody('.diff-wrap {');
    expect(wrapRule).not.toContain('--diff-sign-col:');
    const tokenSheet = readFileSync(new URL('../../../app-ui/src/style.css', import.meta.url), 'utf8');
    expect(tokenSheet).toContain('--diff-sign-col: 14px;');
    const signRule = ruleBody('\n.diff-sign {');
    expect(signRule).toContain('width: var(--diff-sign-col);');
    expect(signRule).not.toContain('width: 14px');
    // The counter gutter derives its reservation from the same token.
    const counterRow = ruleBody('.diff-wrap.md-code-nums .diff-line:not(.diff-hunk) {');
    expect(counterRow).toContain('var(--diff-sign-col)');
    const counterBefore = ruleBody('.diff-wrap.md-code-nums .diff-line:not(.diff-hunk)::before {');
    expect(counterBefore).toContain('var(--diff-sign-col)');
    // And no hardcoded 14px survives anywhere in the diff styles (comments
    // stripped first).
    const withoutComments = vue.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toMatch(/\.diff[^{]*\{[^}]*\b14px\b/);
  });

  it('diff counter box is pinned at 3ch with left overflow for 4+-digit numbers', () => {
    const beforeRule = ruleBody('.diff-wrap.md-code-nums .diff-line:not(.diff-hunk)::before {');
    expect(beforeRule).toContain('width: 3ch;');
    expect(beforeRule).toContain('overflow: visible;');
  });
});
