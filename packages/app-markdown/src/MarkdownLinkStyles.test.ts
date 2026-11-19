import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const component = readFileSync(new URL('./Markdown.vue', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../app-ui/src/markdown-tokens.css', import.meta.url), 'utf8');

function declarations(selector: string): string {
  const rule = `${selector} {`;
  const start = component.indexOf(rule);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const end = component.indexOf('\n}', start);
  expect(end, selector).toBeGreaterThan(start);
  return component.slice(start + rule.length, end);
}

it('uses Markdown tokens for both text and file link geometry', () => {
  for (const selector of ['.md :deep(.md-file-link)', '.md :deep(a:not(.mention-pill):not(:has(img)))']) {
    const rule = declarations(selector);
    expect(rule).toContain('padding: var(--markdown-link-padding-block) var(--markdown-link-padding-inline);');
    expect(rule).toContain('border-radius: var(--markdown-link-radius);');
    expect(rule).not.toContain('--radius-xs');
  }
  expect(tokens).toContain('--markdown-link-padding-block: 0.125rem;');
  expect(tokens).toContain('--markdown-link-padding-inline: 0.25rem;');
  expect(tokens).toContain('--markdown-link-radius: 0.25rem;');
});

it('preserves basic link styling for image links and scopes hover treatment to text links', () => {
  const base = declarations('.md :deep(a)');
  expect(base).toContain('color: var(--markdown-link-color);');
  expect(base).toContain('text-decoration: underline;');
  expect(base).toContain('text-underline-offset: auto;');

  const text = declarations('.md :deep(a:not(.mention-pill):not(:has(img)))');
  expect(text).toContain('text-decoration: none;');
  expect(declarations('.md :deep(a:not(.mention-pill):not(:has(img)):hover)')).toContain('background: var(--markdown-link-hover-background);');
});
