// packages/app-composer/test/composer-mention-matrix.test.ts
import { describe, expect, it } from 'vitest';
import { micromark } from 'micromark';
import { classifyMentionHref, decodeSkillName, docToText, parseMentionLinks, serializeMention, SKILL_LINK_BASE, textToDoc, unescapeRenderedLinkText, type MentionAttrs } from '../src/composerTextDoc';

/**
 * The exhaustive mention-wire matrix. Every character that carries special
 * meaning in ANY layer the wire crosses — CommonMark structure ([ ] ( ) < > \),
 * inline HTML (&), URI (# ? : / %), shell/punctuation exotica, ASCII
 * whitespace, plus Unicode representatives — in every position class,
 * through BOTH consumers of the wire:
 *
 *   1. the composer revive path (micromark subset → attrs), and
 *   2. the rendered Markdown surface (full micromark → href + link text →
 *      the message-side decode chain).
 *
 * Per case the assertions are: revive restores the exact attrs; the wire is
 * idempotent (parse ∘ serialize = identity on the wire itself); the dest is
 * canonical (pure RFC-3986-unreserved ASCII + '/%' — a real renderer's URI
 * normalization is a no-op on it, asserted via the full-micromark href);
 * and the rendered decode restores the same attrs.
 */

// Characters with special meaning in at least one layer. '/' cannot appear
// in a POSIX basename (it is the separator — folder cases cover it).
const META = [
  '[', ']', '(', ')', '<', '>', '\\', '&', '%', '#', '?', ':',
  "'", '"', '`', '*', '!', '~', '^', '_', '{', '}', '|',
  '=', '@', ',', ';', '+', '$', ' ', '\t', '\r', '\n',
];
const UNICODE_REPS = ['第', '🍱', 'é'];
const ALPHABET = [...META, ...UNICODE_REPS];

/** Extract the first rendered link the way the message surface sees it:
 *  href attribute + textContent (tags stripped, HTML references decoded).
 *  allowDangerousProtocol matches the app's renderer: markstream keeps
 *  custom schemes (kimi-code:// links DO render as pills in production),
 *  where micromark's default sanitizer would blank the href. */
function renderFirstLink(wire: string): { href: string; text: string } | null {
  const html = micromark(wire, { allowDangerousProtocol: true });
  const m = html.match(/<a href="([^"]*)">([\s\S]*?)<\/a>/);
  if (!m) return null;
  const text = m[2]!
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
  return { href: m[1]!, text };
}

/** The message-side decode chain, exactly as Markdown.vue runs it. */
function surfaceDecode(rendered: { href: string; text: string }): MentionAttrs | null {
  const kind = classifyMentionHref(rendered.href);
  if (kind === null) return null;
  if (kind === 'skill') return { kind: 'skill', name: decodeSkillName(rendered.href), path: '' };
  let path = rendered.href;
  try {
    path = decodeURIComponent(rendered.href);
  } catch {
    // keep the raw href (malformed percent sequence — never from our wire)
  }
  return { kind, name: unescapeRenderedLinkText(rendered.text), path };
}

// Canonical = ASCII only from the unreserved set + '/%', plus any non-ASCII
// (kept literal for readability — the renderer percent-encodes it and the
// message side single-decodes it back).
const CANONICAL_DEST = /^(?:[A-Za-z0-9\-._~/%]|[\u0080-\u{10FFFF}])*$/u;
/** True when the dest carries no non-ASCII — the renderer's URI normalization
 *  is then a no-op and the href arrives byte-identical. */
function isPureAscii(s: string): boolean {
  for (const ch of s) if (ch.codePointAt(0)! > 0x7f) return false;
  return true;
}

/** The dest of a wire link: the first `](` whose `]` is NOT backslash-escaped
 *  (an escaped `\]` is label content; `\\` pairs cancel out). */
function wireDest(wire: string): string {
  let i = wire.indexOf('](');
  while (i !== -1) {
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && wire[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) return wire.slice(i + 2, -1);
    i = wire.indexOf('](', i + 1);
  }
  throw new Error(`no label/dest boundary in ${wire}`);
}

function expectRoundTrip(attrs: MentionAttrs): void {
  const wire = serializeMention(attrs);
  // 1. The composer revive path restores the exact attrs.
  const matches = parseMentionLinks(wire);
  // wireDest locates the dest span independently (backslash-aware), so this
  // also pins rawDest to the exact dest text as written.
  expect(matches, `revive of ${wire}`).toEqual([{ start: 0, end: wire.length, attrs, rawDest: wireDest(wire) }]);
  // 2. Idempotent: the wire re-serializes to itself.
  expect(serializeMention(matches[0]!.attrs), `idempotence of ${wire}`).toBe(wire);
  // 3. …and it survives the doc model (draft restore / history / pillify).
  expect(docToText(textToDoc(wire, { reviveMentions: true }))).toBe(wire);
  // 4. The dest is canonical — pure unreserved ASCII, renderer-inert (for
  //    skills, the encoded name after the fixed marker prefix).
  const dest = wireDest(wire);
  if (attrs.kind === 'skill') {
    expect(dest.startsWith(SKILL_LINK_BASE), `skill marker of ${wire}`).toBe(true);
    expect(dest.slice(SKILL_LINK_BASE.length), `canonical skill tail of ${wire}`).toMatch(CANONICAL_DEST);
  } else {
    expect(dest, `canonical dest of ${wire}`).toMatch(CANONICAL_DEST);
  }
  // 5. The rendered surface restores the same attrs. A pure-ASCII dest is
  //    renderer-inert — the href arrives byte-identical; a dest with literal
  //    non-ASCII gets percent-encoded by the renderer, and the message
  //    side's single decodeURIComponent restores it (asserted by the decode
  //    below). A name containing a backtick / asterisk / underscore / tilde
  //    PAIR forms code/emphasis inside the rendered label (CommonMark inline
  //    semantics — see the degradation describe below); the functional
  //    fields still restore, the label text doesn't.
  const rendered = renderFirstLink(wire);
  expect(rendered, `render of ${wire}`).not.toBeNull();
  if (isPureAscii(dest)) {
    expect(rendered!.href, `renderer-inert href of ${wire}`).toBe(dest);
  }
  const decoded = surfaceDecode(rendered!);
  const pairCount = (ch: string) => attrs.name.split(ch).length - 1;
  const displaySafe = !['`', '*', '_', '~'].some((ch) => pairCount(ch) >= 2);
  if (displaySafe) {
    expect(decoded).toEqual(attrs);
  } else {
    expect(decoded?.kind).toBe(attrs.kind);
    expect(decoded?.path).toBe(attrs.path);
  }
}

describe('mention wire matrix — file paths, every metacharacter × every position', () => {
  it('interior of the basename / interior segment', () => {
    for (const c of ALPHABET) {
      expectRoundTrip({ kind: 'file', name: `a${c}b.md`, path: `docs/a${c}b.md` });
    }
  });

  it('leading character of the basename', () => {
    for (const c of ALPHABET) {
      expectRoundTrip({ kind: 'file', name: `${c}b.md`, path: `docs/${c}b.md` });
    }
  });

  it('leading first path segment (anchor/query/scheme guards)', () => {
    for (const c of ALPHABET) {
      expectRoundTrip({ kind: 'file', name: 'a.md', path: `${c}docs/a.md` });
    }
  });

  it('leading character of a LATER path segment', () => {
    for (const c of ALPHABET) {
      expectRoundTrip({ kind: 'file', name: 'a.md', path: `docs/${c}sub/a.md` });
    }
  });

  it('folder paths (trailing slash) with metacharacters', () => {
    for (const c of ALPHABET) {
      expectRoundTrip({ kind: 'folder', name: `a${c}b`, path: `docs/a${c}b/` });
    }
  });

  it('skill names with metacharacters (identity rides the dest tail)', () => {
    for (const c of ALPHABET) {
      expectRoundTrip({ kind: 'skill', name: `a${c}b`, path: '' });
    }
  });
});

describe('mention wire matrix — structural path shapes', () => {
  it('keeps non-ASCII paths literal in the wire (copy/readability)', () => {
    // A user copying a CJK-path link must not get percent soup: CommonMark's
    // bare destination allows non-ASCII, the classifier guards are ASCII
    // patterns, and the renderer re-encodes them for the message side's
    // single decode.
    expect(serializeMention({ kind: 'file', name: '稿件.md', path: 'docs/稿件.md' })).toBe('[稿件.md](docs/稿件.md)');
    expect(serializeMention({ kind: 'file', name: '稿 件.md', path: '第一/稿 件.md' })).toBe('[稿 件.md](第一/稿%20件.md)');
    expect(serializeMention({ kind: 'skill', name: '翻译 助手', path: '' })).toBe('[翻译 助手](kimi-code://skill/翻译%20助手)');
  });

  it('covers the adversarial shapes the old positional ladder existed for', () => {
    const shapes: Array<[string, string]> = [
      ['a.md', '//mount/file.md'], // POSIX double-slash root
      ['a.md', '//server/share/docs/a.md'], // forward-slash UNC
      ['a.ts', 'C:\\docs\\a.ts'], // Windows drive, backslashes
      ['a.ts', 'C:/docs/a.ts'], // Windows drive, slashes
      ['a.md', '\\\\server\\share\\docs\\a.md'], // backslash UNC
      ['old.md', 'notes:old.md'], // scheme-shaped POSIX name
      ['fixture', 'http:fixture'], // scheme-shaped, longer
      ['#notes.md', '#notes.md'], // leading anchor char
      ['?q.md', '?q.md'], // leading query char
      ['a  b.md', 'docs/a  b.md'], // runs of whitespace
      ['x(1).md', 'x(1).md'], // balanced parens
      ['x(1.md', 'x(1.md'], // unbalanced paren
      ['a%20final.md', 'a%20final.md'], // a literal, valid %xx triplet
      ['a%2Fb.md', 'a%2Fb.md'], // a triplet that would decode to a slash
      ['../x.md', '../sibling/x.md'], // parent segments
      ['/abs.md', '/abs/path/x.md'], // POSIX-absolute
      ['.dotfile', '.config/.dotfile'], // dot segments
    ];
    for (const [name, path] of shapes) {
      expectRoundTrip({ kind: 'file', name, path });
    }
  });
});

/** Small deterministic PRNG so the fuzz is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('mention wire matrix — seeded fuzz over random basenames', () => {
  it('round-trips 300 random filenames through both surfaces', () => {
    const rand = mulberry32(20260816);
    const pool = [...ALPHABET, 'a', 'b', 'c', 'Z', '0', '5', '稿', '件', '🍱', 'd'];
    for (let i = 0; i < 300; i++) {
      const len = 1 + Math.floor(rand() * 11);
      let base = '';
      for (let j = 0; j < len; j++) base += pool[Math.floor(rand() * pool.length)]!;
      const name = `${base}.md`;
      const dirs = ['docs', 'my dir', 'a(b)', '', '第 一', 'x[y]'];
      const dir = dirs[Math.floor(rand() * dirs.length)]!;
      const path = dir ? `${dir}/${name}` : name;
      expectRoundTrip({ kind: 'file', name, path });
    }
  });

  it('round-trips 100 random skill names', () => {
    const rand = mulberry32(42);
    const pool = [...ALPHABET, 'a', 'b', 's', 'k', '技', '能'];
    for (let i = 0; i < 100; i++) {
      const len = 1 + Math.floor(rand() * 9);
      let name = '';
      for (let j = 0; j < len; j++) name += pool[Math.floor(rand() * pool.length)]!;
      expectRoundTrip({ kind: 'skill', name, path: '' });
    }
  });
});

describe('mention wire matrix — documented display degradation on the RENDERED surface only', () => {
  it('names with inline-markup PAIRS lose markers in rendered text (function intact)', () => {
    // A filename with a backtick/asterisk/underscore PAIR forms a code span
    // or emphasis inside the rendered label — the rendered text drops the
    // markers (CommonMark inline semantics; rare POSIX filenames; the revive
    // surface and every functional field — path, probe, open, copy — are
    // unaffected). The wire keeps them losslessly; only the rendered LABEL
    // text degrades.
    const degraded: Array<[string, string]> = [
      ['a`b`c.md', 'docs/a`b`c.md'],
      ['a**b**c.md', 'docs/a**b**c.md'],
      ['a __b__ c.md', 'docs/a __b__ c.md'],
    ];
    for (const [name, path] of degraded) {
      const wire = serializeMention({ kind: 'file', name, path });
      // Revive is lossless…
      expect(parseMentionLinks(wire)[0]!.attrs).toEqual({ kind: 'file', name, path });
      // …and on the rendered surface the PATH (function) restores exactly,
      // while the label text is CommonMark's, not ours.
      const rendered = renderFirstLink(wire)!;
      const decoded = surfaceDecode(rendered);
      expect(decoded?.kind).toBe('file');
      expect(decoded?.path).toBe(path);
    }
  });
});
