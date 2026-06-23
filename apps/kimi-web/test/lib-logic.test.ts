import { getMarkdown, parseMarkdownToStructure } from 'markstream-vue';
import { describe, expect, it } from 'vitest';
import {
  collectFilePathAliases,
  findFilePathLinks,
  parseFilePathLinkCandidate,
} from '../src/lib/filePathLinks';
import { guardLiteralDollarMath } from '../src/lib/mathDelimiters';
import { parseDiff } from '../src/lib/parseDiff';
import { normalizeToolName, toolSummary } from '../src/lib/toolMeta';

describe('parseDiff', () => {
  it('parses multiple files and keeps hunk line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      'diff --git a/src/comment.sql b/src/comment.sql',
      '@@ -5,1 +5,1 @@',
      '--- old comment',
      '+++ new comment',
    ].join('\n');

    expect(parseDiff(diff)).toEqual([
      { type: 'hunk', text: '@@ -1,2 +1,3 @@' },
      { type: 'context', text: 'const a = 1;', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'const b = 2;', oldNo: 2 },
      { type: 'add', text: 'const b = 3;', newNo: 2 },
      { type: 'add', text: 'const c = 4;', newNo: 3 },
      { type: 'hunk', text: '@@ -5,1 +5,1 @@' },
      { type: 'del', text: '-- old comment', oldNo: 5 },
      { type: 'add', text: '++ new comment', newNo: 5 },
    ]);
  });
});

describe('filePathLinks', () => {
  it('rejects URLs and bare unknown filenames', () => {
    expect(parseFilePathLinkCandidate('https://example.com/a.ts')).toBeNull();
    expect(parseFilePathLinkCandidate('e2e-success.png')).toBeNull();
  });

  it('finds path links with line numbers and resolves aliases', () => {
    const aliases = collectFilePathAliases('<img src="/assets/demo.png">');
    expect(aliases.get('demo.png')).toBe('/assets/demo.png');

    expect(
      findFilePathLinks('Open src/a.ts#L12 and demo.png.', { aliases }),
    ).toMatchObject([
      { path: 'src/a.ts', line: 12, text: 'src/a.ts#L12' },
      { path: '/assets/demo.png', text: 'demo.png' },
    ]);
  });
});

describe('toolMeta', () => {
  it('normalizes common tool aliases', () => {
    expect(normalizeToolName('WebFetch')).toBe('web_fetch');
    expect(normalizeToolName('MultiEdit')).toBe('multi_edit');
    expect(normalizeToolName('TodoWrite')).toBe('todo');
    expect(normalizeToolName('rg')).toBe('grep');
  });

  it('summarizes tool arguments for card headers', () => {
    expect(
      toolSummary('Read', JSON.stringify({ path: 'src/a.ts', offset: 10, limit: 5 })),
    ).toBe('src/a.ts:10-15');
    expect(toolSummary('Read', '{}')).toBe('');
    expect(toolSummary('Bash', JSON.stringify({ command: 'pnpm test' }))).toBe('pnpm test');
    expect(
      toolSummary('WebFetch', JSON.stringify({ url: 'https://example.com/path/to' })),
    ).toBe('example.com/path');
  });
});

// Flatten a parsed node tree into leaf-ish `{type, content}` entries so the
// assertions below don't care about paragraph/blockquote/list nesting.
type FlatNode = { type: string; content?: string };
function flatten(nodes: unknown[]): FlatNode[] {
  const out: FlatNode[] = [];
  for (const raw of nodes) {
    const n = raw as { type: string; content?: string; children?: unknown[] };
    if (n.children?.length) out.push(...flatten(n.children));
    else out.push({ type: n.type, content: n.content });
  }
  return out;
}

describe('guardLiteralDollarMath', () => {
  const md = getMarkdown('guardLiteralDollarMath');
  const render = (text: string) =>
    flatten(parseMarkdownToStructure(text, md, { postTransformTokens: guardLiteralDollarMath }));
  const types = (text: string) => render(text).map((n) => n.type);

  it('keeps literal-dollar prose as text, not inline math', () => {
    for (const text of ['Check $PATH before $HOME', 'costs $5 and $10']) {
      expect(types(text)).not.toContain('math_inline');
      expect(render(text)).toEqual([{ type: 'text', content: text }]);
    }
  });

  it('still renders tight inline math and block math', () => {
    expect(render('Einstein $E=mc^2$ famous')).toEqual([
      { type: 'text', content: 'Einstein ' },
      { type: 'math_inline', content: 'E=mc^2' },
      { type: 'text', content: ' famous' },
    ]);
    expect(render('inline $\\frac{1}{2}$ math').map((n) => n.type)).toContain('math_inline');
    expect(render('$$a^2 + b^2 = c^2$$')).toEqual([
      { type: 'math_block', content: 'a^2 + b^2 = c^2' },
    ]);
  });

  it('guards prose dollars nested inside lists and blockquotes', () => {
    expect(types('- $5 and $10')).not.toContain('math_inline');
    expect(types('> $PATH before $HOME')).not.toContain('math_inline');
  });

  it('leaves code spans and a single unmatched dollar untouched', () => {
    expect(types('code `$5 and $10` here')).not.toContain('math_inline');
    expect(render('it costs $5')).toEqual([{ type: 'text', content: 'it costs $5' }]);
  });

  it('keeps multiple real inline math spans on one line', () => {
    expect(render('$A$ and $B$').map((n) => n.type)).toEqual([
      'math_inline',
      'text',
      'math_inline',
    ]);
  });
});
