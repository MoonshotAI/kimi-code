import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildComposerPlaceholderOverlay, commandArgumentPlaceholderAnchor, composerPlaceholderAnchor, composerPlaceholderLayout, isEmptyComposerDoc, setComposerPlaceholderOverlayText } from '../../src/runtime/composerPlaceholder';
import { textToDoc } from '../../src/model';

class FakeEl {
  className = '';
  innerHTML = '';
  textContent = '';
  hidden = false;
  readonly attrs = new Map<string, string>();

  constructor(readonly tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
}

describe('composer placeholder overlay', () => {
  beforeAll(() => {
    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => new FakeEl(tag),
    };
  });

  afterAll(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it('builds hidden, aria-hidden chrome outside the editor', () => {
    const el = buildComposerPlaceholderOverlay('Ask Kimi') as unknown as FakeEl;
    expect(el.tagName).toBe('SPAN');
    expect(el.className).toBe('composer-placeholder-overlay');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe('Ask Kimi');

    const prediction = buildComposerPlaceholderOverlay('Fix <tests>') as unknown as FakeEl;
    expect(prediction.tagName).toBe('SPAN');
    expect(prediction.className).toBe('composer-placeholder-overlay');
    expect(prediction.getAttribute('aria-hidden')).toBe('true');
    expect(prediction.hidden).toBe(true);
    expect(prediction.innerHTML).toBe('Fix &lt;tests&gt;');
  });

  it('keeps exact kbd pairs and escapes every other tag on updates', () => {
    const el = buildComposerPlaceholderOverlay('') as unknown as FakeEl;
    setComposerPlaceholderOverlayText(
      el as unknown as HTMLElement,
      '<script>alert(1)</script>Press <kbd>Ctrl</kbd>+<kbd>S</kbd>',
    );
    expect(el.innerHTML).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;Press <kbd>Ctrl</kbd>+<kbd>S</kbd>',
    );
  });

  it('recognizes only the canonical one-empty-paragraph document', () => {
    expect(isEmptyComposerDoc(textToDoc(''))).toBe(true);
    expect(isEmptyComposerDoc(textToDoc('x'))).toBe(false);
    expect(isEmptyComposerDoc(textToDoc('\n'))).toBe(false);
  });

  it('converts a viewport line anchor to scroll-content coordinates', () => {
    expect(
      composerPlaceholderLayout(
        { left: 164, top: 88 },
        { left: 100, top: 40 },
        { left: 7, top: 11 },
        300,
      ),
    ).toEqual({ left: 71, top: 59, maxWidth: 236 });
  });

  it('uses the current paragraph line as the baseline without a prefix', () => {
    expect(composerPlaceholderAnchor({ left: 22, top: 10 })).toEqual({ left: 22, top: 10 });
  });

  it('anchors after inline and touch prefixes including their margins', () => {
    expect(
      composerPlaceholderAnchor(
        { left: 22, top: 10 },
        { left: 20, right: 96, top: 12, bottom: 33 },
        { lane: 'inline', marginRight: 6, marginBottom: 0 },
      ),
    ).toEqual({ left: 102, top: 10 });
    expect(
      composerPlaceholderAnchor(
        { left: 22, top: 12 },
        { left: 20, right: 96, top: 12, bottom: 36 },
        { lane: 'block', marginRight: 0, marginBottom: 12 },
      ),
    ).toEqual({ left: 22, top: 48 });
  });

  it('never returns a negative available width', () => {
    expect(
      composerPlaceholderLayout(
        { left: 500, top: 0 },
        { left: 0, top: 0 },
        { left: 0, top: 0 },
        320,
      ).maxWidth,
    ).toBe(0);
  });

  it('lifts a caret glyph-box anchor to the line box top by half the leading', () => {
    expect(
      commandArgumentPlaceholderAnchor({ left: 40, right: 48, top: 52, bottom: 69 }, 24),
    ).toEqual({ left: 40, top: 48.5 });
  });

  it('keeps the caret anchor when the line box adds no leading', () => {
    expect(
      commandArgumentPlaceholderAnchor({ left: 40, right: 48, top: 52, bottom: 69 }, 17),
    ).toEqual({ left: 40, top: 52 });
  });

  it('keeps the caret anchor when the line height is not a length', () => {
    expect(
      commandArgumentPlaceholderAnchor({ left: 40, right: 48, top: 52, bottom: 69 }, Number.NaN),
    ).toEqual({ left: 40, top: 52 });
  });
});
