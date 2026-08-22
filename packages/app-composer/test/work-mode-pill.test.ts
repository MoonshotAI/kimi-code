// Work-mode pill / placeholder decorations: the pill is a widget decoration
// at the document head — never document content — so pasting any amount of
// text can neither push it off the head nor mix it into the serialized wire
// text. These tests pin the position/side/key discipline and the big-paste
// invariant at the doc level; the DOM builders run against a minimal document
// stub (the composer tests are pure-logic, no jsdom).
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Decoration } from 'prosemirror-view';
import { composerSchema, docToText, parseClipboardText, textToDoc } from '../src/composerTextDoc';
import { buildComposerDecorations, buildComposerPlaceholder, buildWorkModePill, type WorkModePillSpec } from '../src/workModePill';

const PLAN: WorkModePillSpec = { mode: 'plan', label: 'Plan', dismissLabel: 'Dismiss' };
const noop = (): void => {};

function decorationsOf(doc: Parameters<typeof buildComposerDecorations>[0], pill: WorkModePillSpec | null, placeholder = ''): Decoration[] {
  const set = buildComposerDecorations(doc, { pill, placeholder }, noop);
  return set ? set.find() : [];
}

describe('buildComposerDecorations', () => {
  it('pins the pill to the document head (position 1) on any doc', () => {
    const doc = textToDoc('first\nsecond\nthird');
    const [pill] = decorationsOf(doc, PLAN);
    expect(pill).toBeDefined();
    expect(pill!.from).toBe(1);
    expect(pill!.to).toBe(1);
  });

  it('renders nothing when no pill is armed and the doc has content', () => {
    expect(decorationsOf(textToDoc('hello'), null, 'Ask Kimi')).toEqual([]);
  });

  it('renders nothing for an empty doc without a placeholder', () => {
    expect(decorationsOf(textToDoc(''), null, '')).toEqual([]);
  });

  it('draws the placeholder only while the doc is empty', () => {
    const empty = decorationsOf(textToDoc(''), null, 'Ask Kimi');
    expect(empty).toHaveLength(1);
    expect(empty[0]!.from).toBe(1);
    expect(decorationsOf(textToDoc('x'), null, 'Ask Kimi')).toEqual([]);
  });

  it('orders pill before placeholder before text via widget sides', () => {
    const [pill, placeholder] = decorationsOf(textToDoc(''), PLAN, 'Ask Kimi');
    expect(pill).toBeDefined();
    expect(placeholder).toBeDefined();
    // A negative side draws the pill BEFORE a cursor at its position and
    // keeps content inserted there after it; the placeholder (side 0) draws
    // after the cursor. Lower side first: pill → placeholder.
    expect(pill!.type.side).toBeLessThan(0);
    expect(placeholder!.type.side).toBeGreaterThanOrEqual(0);
    expect(pill!.type.side).toBeLessThan(placeholder!.type.side);
  });

  it('gives the pill interactive-chrome specs (its × owns its events)', () => {
    const [pill] = decorationsOf(textToDoc(''), PLAN);
    expect(pill!.type.spec.ignoreSelection).toBe(true);
    expect(pill!.type.spec.stopEvent!(new Event('mousedown'))).toBe(true);
  });

  it('reuses widget keys for identical specs and changes them with content', () => {
    const doc = textToDoc('');
    const keyOf = (pill: WorkModePillSpec | null, placeholder = ''): (string | undefined)[] =>
      decorationsOf(doc, pill, placeholder).map((d) => d.type.spec.key as string | undefined);
    // Identical re-renders keep the key (PM preserves the widget DOM).
    expect(keyOf(PLAN)).toEqual(keyOf(PLAN));
    // A mode or label swap (locale change) must rebuild the DOM: new key.
    expect(keyOf(PLAN)).not.toEqual(keyOf({ ...PLAN, label: '计划' }));
    expect(keyOf(PLAN)).not.toEqual(keyOf({ ...PLAN, mode: 'goal' }));
    expect(keyOf(null, 'Ask Kimi')).not.toEqual(keyOf(null, '问点什么'));
  });
});

// ---------------------------------------------------------------------------
// DOM builders (run against a minimal document stub — no jsdom in this repo)
// ---------------------------------------------------------------------------

class FakeEl {
  className = '';
  textContent = '';
  innerHTML = '';
  type = '';
  dataset: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly tagName: string) {
    // Real DOM uppercases tagName.
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  append(...kids: FakeEl[]): void {
    this.children.push(...kids);
  }
}

describe('DOM builders', () => {
  beforeAll(() => {
    (globalThis as { document?: unknown }).document = { createElement: (tag: string) => new FakeEl(tag) };
  });
  afterAll(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it('builds the placeholder as purely visual chrome (aria-hidden)', () => {
    // The same text names the editor via the root's aria-label — the visible
    // placeholder must not ALSO enter the accessibility tree as the field's
    // value (the ::before overlay it replaces never did).
    const el = buildComposerPlaceholder('Ask Kimi') as unknown as FakeEl;
    expect(el.tagName).toBe('SPAN');
    expect(el.className).toBe('wm-placeholder');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.innerHTML).toBe('Ask Kimi');
  });

  it('renders the placeholder copy’s whitelisted <kbd> pairs as keycap markup', () => {
    // The running-state copy carries shortcuts: exact <kbd>…</kbd> pairs
    // survive as keycaps while everything else stays escaped text (app-core
    // placeholderHtml — a malformed translation degrades to literal text,
    // never to injected markup).
    const el = buildComposerPlaceholder(
      'Press <kbd>Enter</kbd> to queue · <kbd>Ctrl</kbd>+<kbd>S</kbd> to inject',
    ) as unknown as FakeEl;
    expect(el.innerHTML).toBe(
      'Press <kbd>Enter</kbd> to queue · <kbd>Ctrl</kbd>+<kbd>S</kbd> to inject',
    );
  });

  it('escapes anything beyond exact <kbd> pairs — no markup injection', () => {
    const el = buildComposerPlaceholder(
      '<script>alert(1)</script><kbd>Esc</kbd>',
    ) as unknown as FakeEl;
    expect(el.innerHTML).toBe('&lt;script&gt;alert(1)&lt;/script&gt;<kbd>Esc</kbd>');
  });

  it('builds the pill with mode glyph, label, and a working dismiss button', () => {
    let dismissed = 0;
    const pill = buildWorkModePill(PLAN, () => dismissed++) as unknown as FakeEl;
    expect(pill.className).toBe('wm-pill');
    expect(pill.dataset.workMode).toBe('plan');
    const [icon, label, dismiss] = pill.children;
    expect(icon!.getAttribute('aria-hidden')).toBe('true');
    expect(icon!.innerHTML).toContain('<svg');
    expect(label!.textContent).toBe('Plan');
    expect(dismiss!.tagName).toBe('BUTTON');
    expect(dismiss!.className).toBe('wm-x');
    expect(dismiss!.getAttribute('aria-label')).toBe('Dismiss');
    expect(dismiss!.innerHTML).toContain('<svg');
    // mousedown is swallowed (no focus steal / selection); click disarms.
    let prevented = false;
    dismiss!.dispatch('mousedown', { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    dismiss!.dispatch('click', {});
    expect(dismissed).toBe(1);
  });

  it('draws a different mode glyph for goal than for plan', () => {
    const iconHtml = (mode: 'plan' | 'goal'): string =>
      (buildWorkModePill({ ...PLAN, mode }, noop) as unknown as FakeEl).children[0]!.innerHTML;
    expect(iconHtml('goal')).not.toBe(iconHtml('plan'));
  });
});

describe('work-mode pill invariants under paste', () => {
  // The reported repro: with a plan pill armed, paste a large mention-heavy
  // text. The pill must stay at the head and out of the serialized text.
  const line = '[apps](apps/) 测试 [lark-apps](kimi-code://skill/lark-apps) 不要回复';
  const bigPaste = Array.from({ length: 120 }, () => line).join('\n');

  it('paste can never precede the pill or move it off the head', () => {
    // The caret sits at the document head (right after where the pill
    // renders); the pasted slice lands there.
    const state = EditorState.create({ schema: composerSchema, doc: textToDoc('') });
    const pasted = state.apply(state.tr.replaceSelection(parseClipboardText(bigPaste, { reviveMentions: true })));
    expect(pasted.doc.childCount).toBe(120);

    // Rebuilt for the new doc, the pill decoration is still exactly one
    // widget at the head, with no placeholder (the doc has content).
    const decorations = decorationsOf(pasted.doc, PLAN, 'Ask Kimi');
    expect(decorations).toHaveLength(1);
    expect(decorations[0]!.from).toBe(1);
    // Its negative side maps insertions at position 1 to AFTER the widget,
    // so even a head-position paste lands behind the pill.
    expect(decorations[0]!.type.side).toBeLessThan(0);
  });

  it('the pill never enters the serialized wire text', () => {
    const state = EditorState.create({ schema: composerSchema, doc: textToDoc('') });
    const pasted = state.apply(state.tr.replaceSelection(parseClipboardText(bigPaste, { reviveMentions: true })));
    // Decorations are not document content: the text the composer submits is
    // byte-identical with and without an armed pill.
    decorationsOf(pasted.doc, PLAN, 'Ask Kimi');
    expect(docToText(pasted.doc)).toBe(bigPaste);
    expect(docToText(pasted.doc)).toContain('[lark-apps](kimi-code://skill/lark-apps)');
    expect(docToText(pasted.doc)).not.toContain('Plan');
  });
});
