import { describe, expect, it } from 'vitest';
import { micromark } from 'micromark';
import { classifyMentionHref, decodeSkillName, docToText, parseMentionLinks, serializeMention, SKILL_LINK_BASE, textToDoc, unescapeRenderedLinkText, type MentionAttrs } from '../../src/model';

const META = [
  '[', ']', '(', ')', '<', '>', '\\', '&', '%', '#', '?', ':',
  "'", '"', '`', '*', '!', '~', '^', '_', '{', '}', '|',
  '=', '@', ',', ';', '+', '$', ' ', '\t', '\r', '\n',
];
const UNICODE_REPS = ['第', '🍱', 'é'];
const ALPHABET = [...META, ...UNICODE_REPS];
const POSITION_REPS = ['[', ']', '(', ')', '\\', '&', '%', '#', '?', ':', '`', '*', '_', '~', ' ', '\t', '\n', ...UNICODE_REPS];

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

function surfaceDecode(rendered: { href: string; text: string }): MentionAttrs | null {
  const kind = classifyMentionHref(rendered.href);
  if (kind === null) return null;
  if (kind === 'skill') return { kind: 'skill', name: decodeSkillName(rendered.href), path: '' };
  let path = rendered.href;
  try {
    path = decodeURIComponent(rendered.href);
  } catch {}
  return { kind, name: unescapeRenderedLinkText(rendered.text), path };
}

const CANONICAL_DEST = /^(?:[A-Za-z0-9\-._~:/%]|[\u0080-\u{10FFFF}])*$/u;
function isPureAscii(s: string): boolean {
  for (const ch of s) if (ch.codePointAt(0)! > 0x7f) return false;
  return true;
}

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
  const matches = parseMentionLinks(wire);
  expect(matches, `revive of ${wire}`).toEqual([{ start: 0, end: wire.length, attrs, rawDest: wireDest(wire) }]);
  expect(serializeMention(matches[0]!.attrs), `idempotence of ${wire}`).toBe(wire);
  expect(docToText(textToDoc(wire, { reviveMentions: true }))).toBe(wire);
  const dest = wireDest(wire);
  if (attrs.kind === 'skill') {
    expect(dest.startsWith(SKILL_LINK_BASE), `skill marker of ${wire}`).toBe(true);
    expect(dest.slice(SKILL_LINK_BASE.length), `canonical skill tail of ${wire}`).toMatch(CANONICAL_DEST);
  } else {
    expect(dest, `canonical dest of ${wire}`).toMatch(CANONICAL_DEST);
  }
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

describe('mention wire matrix — metacharacter coverage by position', () => {
  it('covers every metacharacter inside the basename', () => {
    for (const c of ALPHABET) {
      expectRoundTrip({ kind: 'file', name: `a${c}b.md`, path: `docs/a${c}b.md` });
    }
  });

  it('covers character classes at the start of the basename', () => {
    for (const c of POSITION_REPS) {
      expectRoundTrip({ kind: 'file', name: `${c}b.md`, path: `docs/${c}b.md` });
    }
  });

  it('covers character classes at the first path segment boundary', () => {
    for (const c of POSITION_REPS) {
      expectRoundTrip({ kind: 'file', name: 'a.md', path: `${c}docs/a.md` });
    }
  });

  it('covers character classes at later path segment boundaries', () => {
    for (const c of POSITION_REPS) {
      expectRoundTrip({ kind: 'file', name: 'a.md', path: `docs/${c}sub/a.md` });
    }
  });

  it('covers character classes in folder paths', () => {
    for (const c of POSITION_REPS) {
      expectRoundTrip({ kind: 'folder', name: `a${c}b`, path: `docs/a${c}b/` });
    }
  });

  it('covers character classes in skill names', () => {
    for (const c of POSITION_REPS) {
      expectRoundTrip({ kind: 'skill', name: `a${c}b`, path: '' });
    }
  });
});

describe('mention wire matrix — structural path shapes', () => {
  it('keeps non-ASCII paths literal in the wire (copy/readability)', () => {
    expect(serializeMention({ kind: 'file', name: '稿件.md', path: 'docs/稿件.md' })).toBe('[稿件.md](docs/稿件.md)');
    expect(serializeMention({ kind: 'file', name: '稿 件.md', path: '第一/稿 件.md' })).toBe('[稿 件.md](第一/稿%20件.md)');
    expect(serializeMention({ kind: 'skill', name: '翻译 助手', path: '' })).toBe('[翻译 助手](kimi-code://skill/翻译%20助手)');
  });

  it('covers the adversarial shapes the old positional ladder existed for', () => {
    const shapes: Array<[string, string]> = [
      ['a.md', '//mount/file.md'],
      ['a.md', '//server/share/docs/a.md'],
      ['a.ts', 'C:\\docs\\a.ts'],
      ['a.ts', 'C:/docs/a.ts'],
      ['a.md', '\\\\server\\share\\docs\\a.md'],
      ['old.md', 'notes:old.md'],
      ['fixture', 'http:fixture'],
      ['#notes.md', '#notes.md'],
      ['?q.md', '?q.md'],
      ['a  b.md', 'docs/a  b.md'],
      ['x(1).md', 'x(1).md'],
      ['x(1.md', 'x(1.md'],
      ['a%20final.md', 'a%20final.md'],
      ['a%2Fb.md', 'a%2Fb.md'],
      ['../x.md', '../sibling/x.md'],
      ['/abs.md', '/abs/path/x.md'],
      ['.dotfile', '.config/.dotfile'],
    ];
    for (const [name, path] of shapes) {
      expectRoundTrip({ kind: 'file', name, path });
    }
  });
});

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
  it('round-trips 100 seeded file and skill names through both surfaces', () => {
    const rand = mulberry32(20260816);
    const pool = [...ALPHABET, 'a', 'b', 'c', 'Z', '0', '5', '稿', '件', '技', '能'];
    const dirs = ['docs', 'my dir', 'a(b)', '', '第 一', 'x[y]'];
    for (let i = 0; i < 100; i++) {
      const len = 1 + Math.floor(rand() * 11);
      let base = '';
      for (let j = 0; j < len; j++) base += pool[Math.floor(rand() * pool.length)]!;
      if (i % 2 === 0) {
        const name = `${base}.md`;
        const dir = dirs[Math.floor(rand() * dirs.length)]!;
        expectRoundTrip({ kind: 'file', name, path: dir ? `${dir}/${name}` : name });
      } else {
        expectRoundTrip({ kind: 'skill', name: base, path: '' });
      }
    }
  });
});

describe('mention wire matrix — documented display degradation on the RENDERED surface only', () => {
  it('names with inline-markup PAIRS lose markers in rendered text (function intact)', () => {
    const degraded: Array<[string, string]> = [
      ['a`b`c.md', 'docs/a`b`c.md'],
      ['a**b**c.md', 'docs/a**b**c.md'],
      ['a __b__ c.md', 'docs/a __b__ c.md'],
    ];
    for (const [name, path] of degraded) {
      const wire = serializeMention({ kind: 'file', name, path });
      expect(parseMentionLinks(wire)[0]!.attrs).toEqual({ kind: 'file', name, path });
      const rendered = renderFirstLink(wire)!;
      const decoded = surfaceDecode(rendered);
      expect(decoded?.kind).toBe('file');
      expect(decoded?.path).toBe(path);
    }
  });
});
