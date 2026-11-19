import { describe, expect, it } from 'vitest';
import { codeToTokens } from 'shiki';
import { MARKDOWN_CODE_THEME_DEFINITION } from '../../../../packages/app-markdown/src/lib/codeTheme';

describe('Markdown source highlighting', () => {
  it('colors Markdown syntax and embedded code while preserving source text', async () => {
    const source = '# Heading\n\n**bold** *italic* ~~strike~~\n[link](https://example.com) `code`\n- item\n> quote\n```js\nconst value = 42\n```';
    const { tokens } = await codeToTokens(source, { lang: 'markdown', theme: MARKDOWN_CODE_THEME_DEFINITION });
    expect(tokens.map(line => line.map(token => token.content).join('')).join('\n')).toBe(source);
    const colorOf = (text: string) => tokens.flat().find(token => token.content.includes(text))?.color;
    expect(colorOf('Heading')).toBe('var(--markdown-syntax-heading-color)');
    expect(colorOf('bold')).toBe('var(--markdown-syntax-keyword-color)');
    expect(colorOf('italic')).toBe('var(--markdown-syntax-keyword-color)');
    expect(colorOf('strike')).toBe('var(--markdown-syntax-comment-color)');
    expect(colorOf('link')).toBe('var(--markdown-link-color)');
    expect(colorOf('code')).toBe('var(--markdown-syntax-string-color)');
    expect(colorOf('quote')).toBe('var(--markdown-syntax-comment-color)');
    expect(colorOf('const')).toBe('var(--markdown-syntax-keyword-color)');
    expect(colorOf('42')).toBe('var(--markdown-syntax-number-color)');
  });
});
