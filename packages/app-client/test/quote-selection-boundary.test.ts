// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectionHitByPointer, selectionOwnedByRoot, selectionQuoteAnchor } from '../src/lib/quoteSelection';

let host: HTMLDivElement;
let root: HTMLElement;
let text: Node;
let next: HTMLElement;
const originalRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');

function select(end: Node, offset: number): Selection {
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(end, offset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

beforeEach(() => {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(20, 40, 100, 20),
  });
  host = document.createElement('div');
  host.innerHTML = '<section><div class="a-msg"><div class="msg"><p>Selected paragraph</p></div></div></section><div class="a-msg"><div class="msg"><p>Another message</p></div></div>';
  document.body.append(host);
  root = host.querySelector('section')!;
  text = root.querySelector('p')!.firstChild!;
  next = host.querySelectorAll('p')[1]!;
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  host.remove();
  if (originalRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRect);
  else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
});

describe('paragraph selection boundaries', () => {
  it('keeps a paragraph whose end is the start of the next message', () => {
    const selection = select(next, 0);
    expect(selectionQuoteAnchor(selection)?.quote).toBe('Selected paragraph');
    expect(selectionOwnedByRoot(selection, root)).toBe(true);
    expect(selection.getRangeAt(0).endContainer).toBe(next);
  });

  it('accepts the next text node at offset zero without including that text', () => {
    const selection = select(next.firstChild!, 0);
    expect(selectionQuoteAnchor(selection)?.quote).toBe('Selected paragraph');
    expect(selectionOwnedByRoot(selection, root)).toBe(true);
  });

  it('keeps a selection ending at the parent boundary just after its root', () => {
    const selection = select(host, 1);
    expect(selectionQuoteAnchor(selection)?.quote).toBe('Selected paragraph');
    expect(selectionOwnedByRoot(selection, root)).toBe(true);
  });

  it('still rejects selecting a character in the next message', () => {
    const selection = select(next.firstChild!, 1);
    expect(selectionQuoteAnchor(selection)).toBeNull();
    expect(selectionOwnedByRoot(selection, root)).toBe(false);
  });

  it('rejects a parent boundary when it includes another message', () => {
    const selection = select(host, 2);
    expect(selectionQuoteAnchor(selection)).toBeNull();
    expect(selectionOwnedByRoot(selection, root)).toBe(false);
  });

  describe('triple click before an unselectable header', () => {
    function appendActivityRun(headerStyle: string): { label: Node; command: Node } {
      const run = document.createElement('div');
      run.innerHTML = `<button style="${headerStyle}"><span>Done</span><span>Ran 1 command</span></button><div><span style="user-select: none">Run</span> <code>rg -ln foo</code></div>`;
      root.querySelector('.a-msg')!.append(run);
      return { label: run.querySelector('div > span')!.firstChild!, command: run.querySelector('code')!.firstChild! };
    }

    it('keeps a paragraph whose range extends over unselectable text into the next block', () => {
      const { label } = appendActivityRun('user-select: none');
      const selection = select(label, 3);
      expect(selectionQuoteAnchor(selection)).not.toBeNull();
      expect(selectionOwnedByRoot(selection, root)).toBe(true);
    });

    it('still rejects when the range covers selectable text after the paragraph', () => {
      const { command } = appendActivityRun('user-select: none');
      expect(selectionQuoteAnchor(select(command, 2))).toBeNull();
    });

    it('still rejects when the skipped header is selectable', () => {
      const { label } = appendActivityRun('');
      expect(selectionQuoteAnchor(select(label, 3))).toBeNull();
    });
  });

  it('does not claim a paragraph selected in another root', () => {
    const selection = select(next, 0);
    expect(selectionOwnedByRoot(selection, next)).toBe(false);
  });
});

describe('context click on a selection inside a shadow tree', () => {
  const originalClientRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  let code: Text;
  let shadowRoot: ShadowRoot;
  let selection: Selection;

  function contextClick(target: Node, clientX: number, clientY: number, check: (event: MouseEvent) => void): void {
    const listener = (event: Event): void => check(event as MouseEvent);
    document.addEventListener('contextmenu', listener, { once: true });
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX, clientY }));
    document.removeEventListener('contextmenu', listener);
  }

  beforeEach(() => {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [new DOMRect(20, 40, 100, 20)],
    });
    const codeHost = document.createElement('diffs-container');
    root.append(codeHost);
    shadowRoot = codeHost.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = '<code>const alpha = 1;</code>';
    code = shadowRoot.querySelector('code')!.firstChild as Text;
    const retargeted = document.createRange();
    retargeted.setStart(root, root.childNodes.length - 1);
    retargeted.collapse(true);
    selection = {
      isCollapsed: true,
      rangeCount: 1,
      getRangeAt: () => retargeted,
      getComposedRanges: (options?: GetComposedRangesOptions) =>
        options?.shadowRoots?.includes(shadowRoot)
          ? [new StaticRange({ startContainer: code, startOffset: 0, endContainer: code, endOffset: 5 })]
          : [new StaticRange({ startContainer: root, startOffset: 1, endContainer: root, endOffset: 1 })],
    } as unknown as Selection;
  });

  afterEach(() => {
    if (originalClientRects) Object.defineProperty(Range.prototype, 'getClientRects', originalClientRects);
    else Reflect.deleteProperty(Range.prototype, 'getClientRects');
  });

  it('resolves the real range from the event path', () => {
    const check = vi.fn((event: MouseEvent) => {
      expect(selectionOwnedByRoot(selection, root, event)).toBe(true);
      expect(selectionOwnedByRoot(selection, next, event)).toBe(false);
      expect(selectionHitByPointer(selection, event)).toBe(true);
    });
    contextClick(shadowRoot.querySelector('code')!, 50, 50, check);
    expect(check).toHaveBeenCalledOnce();
  });

  it('misses when the pointer is outside the selected rects', () => {
    const check = vi.fn((event: MouseEvent) => {
      expect(selectionHitByPointer(selection, event)).toBe(false);
    });
    contextClick(shadowRoot.querySelector('code')!, 200, 50, check);
    expect(check).toHaveBeenCalledOnce();
  });

  it('misses when the pointer is in the light tree', () => {
    const check = vi.fn((event: MouseEvent) => {
      expect(selectionOwnedByRoot(selection, root, event)).toBe(false);
      expect(selectionHitByPointer(selection, event)).toBe(false);
    });
    contextClick(root.querySelector('p')!, 50, 50, check);
    expect(check).toHaveBeenCalledOnce();
  });
});
