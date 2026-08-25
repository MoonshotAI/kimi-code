import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeQuote } from '@moonshot-ai/app-composer';
import { buildQuoteBlock, buildQuoteLines, buildQuotePrompt, clampOverlayAxis, joinDraftSegments, nextMenuIndex, partitionPendingQuotes, rewriteQuoteLinks, selectionOwnedByRoot, selectionQuoteAnchor, sharedQuoteContainer, sweepPendingQuotes } from '../src/lib/quoteSelection';

describe('quoteSelection', () => {
  it('prefixes every line of a multi-line quote with `> `', () => {
    expect(buildQuoteLines('one\ntwo\n\nthree')).toBe('> one\n> two\n> \n> three');
  });

  it('buildQuoteBlock appends a blank line after the quote', () => {
    expect(buildQuoteBlock('hello')).toBe('> hello\n\n');
  });

  it('buildQuotePrompt without a comment is just the quote block', () => {
    expect(buildQuotePrompt('hello')).toBe('> hello\n\n');
    expect(buildQuotePrompt('hello', '   ')).toBe('> hello\n\n');
  });

  it('buildQuotePrompt appends a trimmed comment after the quote block', () => {
    expect(buildQuotePrompt('a\nb', '  why?  ')).toBe('> a\n> b\n\nwhy?');
  });
});

// Wire-equivalence oracle for the pill era: the text-era flow put
// buildQuoteBlock / buildQuotePrompt into the draft and handleSubmit emitted
// text.value.trim() — rewriteQuoteLinks(...).trim() must reproduce that
// byte-for-byte.
const textEra = (draft: string): string => draft.trim();
const link = (text: string): string => serializeQuote({ text });

describe('rewriteQuoteLinks (submit wire equivalence)', () => {
  it('quote-only matches the text-era buildQuoteBlock flow', () => {
    expect(rewriteQuoteLinks(`${link('引用')} `).trim()).toBe(textEra(buildQuoteBlock('引用')));
    expect(rewriteQuoteLinks(`${link('引用')} `).trim()).toBe('> 引用');
  });

  it('comment matches the text-era buildQuotePrompt flow (insertion space eaten)', () => {
    expect(rewriteQuoteLinks(`${link('引用')} 评论`).trim()).toBe(textEra(buildQuotePrompt('引用', '评论')));
    expect(rewriteQuoteLinks(`${link('引用')} 评论`).trim()).toBe('> 引用\n\n评论');
  });

  it('after an existing draft matches the text-era blank-line join', () => {
    const docText = `hello\n\n${link('引用')} `;
    expect(rewriteQuoteLinks(docText.trim()).trim()).toBe(textEra(`hello\n\n${buildQuoteBlock('引用')}`));
    expect(rewriteQuoteLinks(docText.trim()).trim()).toBe('hello\n\n> 引用');
  });

  it('accumulates: two pills match two text-era appends', () => {
    const docText = `${link('q1')} \n\n${link('q2')} `;
    const era = `${buildQuoteBlock('q1')}\n\n${buildQuoteBlock('q2')}`;
    expect(rewriteQuoteLinks(docText.trim()).trim()).toBe(textEra(era));
    expect(rewriteQuoteLinks(docText.trim()).trim()).toBe('> q1\n\n\n\n> q2');
  });

  it('multi-line quotes prefix every line with `> `', () => {
    expect(rewriteQuoteLinks(link('a\nb'))).toBe('> a\n> b\n\n');
  });

  it('leaves non-quote content byte-identical', () => {
    expect(rewriteQuoteLinks('plain [x](src/a.ts) text')).toBe('plain [x](src/a.ts) text');
    expect(rewriteQuoteLinks('[f](kimi-code-composer://attachments/abc12345)')).toBe(
      '[f](kimi-code-composer://attachments/abc12345)',
    );
  });
});

describe('rewriteQuoteLinks — mid-line pill (edited into text)', () => {
  it('breaks the line before the block when the pill is NOT at a line head', () => {
    // Pill edited into mid-line: the `> ` block must start on its own line.
    expect(rewriteQuoteLinks(`前文${link('引用')}`)).toBe('前文\n> 引用\n\n');
    expect(rewriteQuoteLinks(`hello ${link('引用')}`)).toBe('hello\n> 引用\n\n');
  });

  it('stays byte-identical at a line head (start of text or after a newline)', () => {
    expect(rewriteQuoteLinks(link('引用'))).toBe('> 引用\n\n');
    expect(rewriteQuoteLinks(`前文\n${link('引用')}`)).toBe('前文\n> 引用\n\n');
    expect(rewriteQuoteLinks(`前文\n\n${link('引用')}`)).toBe('前文\n\n> 引用\n\n');
  });

  it('mid-line between two pills breaks only where needed', () => {
    expect(rewriteQuoteLinks(`${link('q1')}\n\n前文${link('q2')}`)).toBe('> q1\n\n\n\n前文\n> q2\n\n');
  });
});

describe('rewriteQuoteLinks — image/escaped pill forms (private scheme never leaks)', () => {
  it('rewrites the image form (`!` typed against the pill) like a normal quote link', () => {
    expect(rewriteQuoteLinks(`!${link('引用')}`)).toBe('> 引用\n\n');
    expect(rewriteQuoteLinks(`!${link('引用')} 评论`).trim()).toBe('> 引用\n\n评论');
    expect(rewriteQuoteLinks(`前文!${link('引用')}`)).toBe('前文\n> 引用\n\n');
  });

  it('rewrites the backslash-escaped form like a normal quote link', () => {
    expect(rewriteQuoteLinks(`\\${link('引用')}`)).toBe('> 引用\n\n');
    expect(rewriteQuoteLinks(`\\${link('引用')} 评论`).trim()).toBe('> 引用\n\n评论');
  });

  it('an even backslash run keeps the real link form (backslashes stay literal)', () => {
    expect(rewriteQuoteLinks(`\\\\${link('引用')}`)).toBe('\\\\\n> 引用\n\n');
  });

  it('the composer-private scheme never survives in any form', () => {
    for (const wire of [link('引用'), `!${link('引用')}`, `\\${link('引用')}`]) {
      expect(rewriteQuoteLinks(wire)).not.toContain('kimi-code-composer');
    }
  });
});

describe('sharedQuoteContainer (cross-message selection guard)', () => {
  // Minimal Element stubs — only `closest` is consumed (node env, no DOM).
  const fakeEl = (container: unknown): Element =>
    ({ closest: (sel: string) => (sel === '.a-msg .msg' ? container : null) }) as unknown as Element;
  const MSG = { id: 'msg-1' };
  const OTHER = { id: 'msg-2' };

  it('returns the shared container when both range ends live in the same .a-msg .msg', () => {
    expect(sharedQuoteContainer(fakeEl(MSG), fakeEl(MSG))).toBe(MSG);
  });

  it('rejects a selection spanning two messages', () => {
    expect(sharedQuoteContainer(fakeEl(MSG), fakeEl(OTHER))).toBeNull();
    // Document order is irrelevant (reverse drag): the check is symmetric.
    expect(sharedQuoteContainer(fakeEl(OTHER), fakeEl(MSG))).toBeNull();
  });

  it('rejects when either end is outside an assistant body', () => {
    expect(sharedQuoteContainer(fakeEl(null), fakeEl(MSG))).toBeNull();
    expect(sharedQuoteContainer(fakeEl(MSG), fakeEl(null))).toBeNull();
    expect(sharedQuoteContainer(null, null)).toBeNull();
  });
});

describe('sharedQuoteContainer — shadow-boundary crossing (Pierre code blocks)', () => {
  class FakeShadowRoot {}
  const hostFor = (container: unknown): Element =>
    ({ closest: (sel: string) => (sel === '.a-msg .msg' ? container : null) }) as unknown as Element;
  const shadowedEl = (host: Element): Element => {
    const root = new FakeShadowRoot() as unknown as ShadowRoot;
    (root as { host?: Element }).host = host;
    return {
      closest: () => null, // a shadow-tree element never reaches the light ancestor
      getRootNode: () => root,
    } as unknown as Element;
  };
  const MSG = { id: 'msg-1' };
  const OTHER = { id: 'msg-2' };
  let savedShadowRoot: unknown;

  beforeEach(() => {
    savedShadowRoot = (globalThis as { ShadowRoot?: unknown }).ShadowRoot;
    (globalThis as { ShadowRoot?: unknown }).ShadowRoot = FakeShadowRoot;
  });
  afterEach(() => {
    (globalThis as { ShadowRoot?: unknown }).ShadowRoot = savedShadowRoot;
  });

  it('passes when both shadowed ends reach the same container through the host chain', () => {
    expect(sharedQuoteContainer(shadowedEl(hostFor(MSG)), shadowedEl(hostFor(MSG)))).toBe(MSG);
  });

  it('rejects when the host chains reach different containers', () => {
    expect(sharedQuoteContainer(shadowedEl(hostFor(MSG)), shadowedEl(hostFor(OTHER)))).toBeNull();
    expect(sharedQuoteContainer(shadowedEl(hostFor(MSG)), shadowedEl(hostFor(null)))).toBeNull();
  });

  it('still passes a mixed shadow/light selection within one message', () => {
    const lightEl = { closest: (sel: string) => (sel === '.a-msg .msg' ? MSG : null) } as unknown as Element;
    expect(sharedQuoteContainer(shadowedEl(hostFor(MSG)), lightEl)).toBe(MSG);
  });
});

describe('selectionQuoteAnchor (shared mouseup/keyup evaluation)', () => {
  class FakeElement {}
  const RECT = { left: 100, top: 40, bottom: 60, width: 80, height: 20, right: 180, x: 100, y: 40, toJSON: () => ({}) };
  const MSG = { id: 'msg' };
  const lightEl = Object.assign(new FakeElement(), { closest: (sel: string) => (sel === '.a-msg .msg' ? MSG : null) });
  const outsideEl = Object.assign(new FakeElement(), { closest: () => null });
  // A Selection stub: only what selectionQuoteAnchor consumes.
  function fakeSel(opts: { collapsed?: boolean; text?: string; start?: unknown; end?: unknown; rangeCount?: number }): Selection {
    const range = {
      startContainer: opts.start ?? lightEl,
      endContainer: opts.end ?? lightEl,
      getBoundingClientRect: () => RECT,
    };
    return {
      isCollapsed: opts.collapsed ?? false,
      rangeCount: opts.rangeCount ?? 1,
      toString: () => opts.text ?? '  选中文字  ',
      getRangeAt: () => range,
    } as unknown as Selection;
  }

  let savedElement: unknown;
  beforeEach(() => {
    savedElement = (globalThis as { Element?: unknown }).Element;
    (globalThis as { Element?: unknown }).Element = FakeElement;
  });
  afterEach(() => {
    (globalThis as { Element?: unknown }).Element = savedElement;
  });

  it('returns the anchor for a valid selection (center-x, top, bottom, ORIGINAL text)', () => {
    expect(selectionQuoteAnchor(fakeSel({}))).toEqual({ x: 140, y: 40, bottom: 60, quote: '  选中文字  ' });
  });

  it('keeps leading indentation (code excerpts) but strips outer newlines', () => {
    expect(selectionQuoteAnchor(fakeSel({ text: '    const x = 1;' }))?.quote).toBe('    const x = 1;');
    expect(selectionQuoteAnchor(fakeSel({ text: '\n\n  indented\n\n' }))?.quote).toBe('  indented');
  });

  it('resolves text-node endpoints to their parent element', () => {
    const textNode = { parentElement: lightEl };
    expect(selectionQuoteAnchor(fakeSel({ start: textNode, end: textNode }))).not.toBeNull();
  });

  it('returns null for collapsed, empty-text, or cross/outside selections', () => {
    expect(selectionQuoteAnchor(fakeSel({ collapsed: true }))).toBeNull();
    expect(selectionQuoteAnchor(fakeSel({ text: '   ' }))).toBeNull();
    expect(selectionQuoteAnchor(fakeSel({ end: outsideEl }))).toBeNull();
    expect(selectionQuoteAnchor(null)).toBeNull();
  });

  it('refuses multi-range selections (Firefox Ctrl+drag) outright', () => {
    // Only range 0 would be validated while toString() merges every range's
    // text — a later range could come from another message.
    expect(selectionQuoteAnchor(fakeSel({ rangeCount: 2 }))).toBeNull();
  });
});

describe('clampOverlayAxis (viewport clamp for floating overlays)', () => {
  it('clamps both ends when the overlay is smaller than the viewport', () => {
    expect(clampOverlayAxis(2, 100, 800, 8)).toBe(8); // above the top margin
    expect(clampOverlayAxis(750, 100, 800, 8)).toBe(692); // past the bottom edge
    expect(clampOverlayAxis(400, 100, 800, 8)).toBe(400); // inside
  });

  it('never goes negative when the overlay exceeds the viewport (high zoom)', () => {
    expect(clampOverlayAxis(500, 900, 800, 8)).toBe(8);
    expect(clampOverlayAxis(-50, 900, 800, 8)).toBe(8);
  });

  it('shifts the bounds with the viewport offset (iOS keyboard pan/zoom)', () => {
    // offset=120: the clamped range is [128, 120+800-100-8=812].
    expect(clampOverlayAxis(0, 100, 800, 8, 120)).toBe(128);
    expect(clampOverlayAxis(900, 100, 800, 8, 120)).toBe(812);
    expect(clampOverlayAxis(400, 100, 800, 8, 120)).toBe(400);
  });
});

describe('partitionPendingQuotes (per-session stash queue)', () => {
  const item = (quote: string, sessionId?: string) => ({ quote, sessionId });

  it('replays active-session and session-less items in order, drops other sessions', () => {
    const { replay, dropped } = partitionPendingQuotes(
      [item('q1', 's1'), item('q2', 's2'), item('q3', 's1'), item('q4')],
      's1',
    );
    expect(replay.map((i) => i.quote)).toEqual(['q1', 'q3', 'q4']);
    expect(dropped.map((i) => i.quote)).toEqual(['q2']);
  });

  it('drops everything for another session, keeps all for a session-less active', () => {
    const { replay, dropped } = partitionPendingQuotes([item('q1', 's1'), item('q2')], undefined);
    expect(replay.map((i) => i.quote)).toEqual(['q2']);
    expect(dropped.map((i) => i.quote)).toEqual(['q1']);
  });
});

describe('nextMenuIndex (bubble keyboard navigation)', () => {
  it('enters from -1 at the first item on ArrowDown, the last on ArrowUp', () => {
    expect(nextMenuIndex(-1, 1, 3)).toBe(0);
    expect(nextMenuIndex(-1, -1, 3)).toBe(2);
  });

  it('wraps around both ends', () => {
    expect(nextMenuIndex(2, 1, 3)).toBe(0);
    expect(nextMenuIndex(0, -1, 3)).toBe(2);
    expect(nextMenuIndex(1, 1, 3)).toBe(2);
  });

  it('returns -1 for an empty menu', () => {
    expect(nextMenuIndex(-1, 1, 0)).toBe(-1);
  });
});

describe('selectionOwnedByRoot (selectionchange ownership gate, composed host chain)', () => {
  class FakeShadowRoot {}
  class FakeElement {}
  const root = { id: 'main-root' } as unknown as Node;
  const otherRoot = { id: 'side-root' } as unknown as Node;
  // Light-DOM endpoint: climbs parentElement to `root`.
  const insideEl = Object.assign(new FakeElement(), { parentElement: root }) as unknown as Element;
  // Light-DOM endpoint on another pane's chain (dead-ends at a non-shadow root).
  const outsideEl = Object.assign(new FakeElement(), {
    parentElement: null,
    getRootNode: () => ({ id: 'document' }) as unknown as Node,
  }) as unknown as Element;
  // Shadow-tree endpoint: parentElement-less, hops out through the host.
  const shadowedEl = (host: Element): Element => {
    const shadow = new FakeShadowRoot() as unknown as ShadowRoot;
    (shadow as { host?: Element }).host = host;
    return Object.assign(new FakeElement(), {
      parentElement: null,
      getRootNode: () => shadow,
    }) as unknown as Element;
  };
  const fakeSel = (start: unknown, end: unknown, collapsed = false): Selection =>
    ({
      isCollapsed: collapsed,
      rangeCount: 1,
      getRangeAt: () => ({ startContainer: start, endContainer: end }),
    }) as unknown as Selection;

  let savedShadowRoot: unknown;
  let savedElement: unknown;
  beforeEach(() => {
    savedShadowRoot = (globalThis as { ShadowRoot?: unknown }).ShadowRoot;
    savedElement = (globalThis as { Element?: unknown }).Element;
    (globalThis as { ShadowRoot?: unknown }).ShadowRoot = FakeShadowRoot;
    (globalThis as { Element?: unknown }).Element = FakeElement;
  });
  afterEach(() => {
    (globalThis as { ShadowRoot?: unknown }).ShadowRoot = savedShadowRoot;
    (globalThis as { Element?: unknown }).Element = savedElement;
  });

  it('is true only when BOTH endpoints reach the given root (light DOM)', () => {
    expect(selectionOwnedByRoot(fakeSel(insideEl, insideEl), root)).toBe(true);
    expect(selectionOwnedByRoot(fakeSel(outsideEl, outsideEl), root)).toBe(false);
    expect(selectionOwnedByRoot(fakeSel(insideEl, outsideEl), root)).toBe(false);
  });

  it('resolves shadow-tree endpoints through the host chain (Pierre code blocks)', () => {
    // A selection inside a code block's shadow root belongs to the chat root
    // hosting it — NOT to another pane.
    expect(selectionOwnedByRoot(fakeSel(shadowedEl(root as unknown as Element), shadowedEl(root as unknown as Element)), root)).toBe(true);
    expect(
      selectionOwnedByRoot(fakeSel(shadowedEl(otherRoot as unknown as Element), shadowedEl(otherRoot as unknown as Element)), root),
    ).toBe(false);
  });

  it('is false for collapsed selections, no-range, and null root', () => {
    expect(selectionOwnedByRoot(fakeSel(insideEl, insideEl, true), root)).toBe(false);
    expect(selectionOwnedByRoot(null, root)).toBe(false);
    expect(selectionOwnedByRoot(fakeSel(insideEl, insideEl), null)).toBe(false);
  });
});

describe('sweepPendingQuotes (session round-trip cleanup)', () => {
  const item = (quote: string, sessionId?: string) => ({ quote, sessionId });

  it('drops the left session’s queue on a switch even when the composer never became ready', () => {
    // A → B with the composer hidden the whole time: replay never fires, but
    // A's items must die at the switch.
    const kept = sweepPendingQuotes([item('qA', 'sA'), item('qB', 'sB')], 'sB', () => false);
    expect(kept.map((i) => i.quote)).toEqual(['qB']);
  });

  it('an A→B→A round trip never replays A’s stash', () => {
    let queue = [item('qA', 'sA'), item('qB', 'sB')];
    queue = sweepPendingQuotes(queue, 'sB', () => false); // A → B (hidden)
    const replayed: string[] = [];
    queue = sweepPendingQuotes(queue, 'sA', (i) => {
      // B → A, composer ready again: only items still queued for A may replay
      // (none — A's died at the switch; B's now die too).
      replayed.push(i.quote);
      return true;
    });
    expect(replayed).toEqual([]);
    expect(queue).toEqual([]);
  });

  it('replays active-session items in order and re-queues failures', () => {
    const inserted: string[] = [];
    const kept = sweepPendingQuotes([item('q1', 's'), item('q2', 's'), item('q3', 's')], 's', (i) => {
      inserted.push(i.quote);
      return i.quote !== 'q2'; // q2 fails to insert
    });
    expect(inserted).toEqual(['q1', 'q2', 'q3']);
    expect(kept.map((i) => i.quote)).toEqual(['q2']);
  });
});

describe('joinDraftSegments (draft + insertion newline normalization)', () => {
  it('passes the insertion through on an empty draft', () => {
    expect(joinDraftSegments('', '> 引用\n\n')).toBe('> 引用\n\n');
    expect(joinDraftSegments('', '')).toBe('');
  });

  it('joins with exactly one blank line — never four newlines on repeat inserts', () => {
    expect(joinDraftSegments('已有文字', '> 引用\n\n')).toBe('已有文字\n\n> 引用\n\n');
    expect(joinDraftSegments('> q1\n\n', '> q2\n\n')).toBe('> q1\n\n> q2\n\n');
    expect(joinDraftSegments('已有\n\n\n', '\n\n插入')).toBe('已有\n\n插入');
    expect(joinDraftSegments('> q1\n\n> q2\n\n', '> q3\n\n')).toBe('> q1\n\n> q2\n\n> q3\n\n');
  });
});
