import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const component = readFileSync(new URL('./Markdown.vue', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../app-ui/src/markdown-tokens.css', import.meta.url), 'utf8');
const sharedStyles = readFileSync(new URL('../../app-ui/src/style.css', import.meta.url), 'utf8');
const composerComponent = readFileSync(new URL('../../app-components/src/composer/Composer.vue', import.meta.url), 'utf8');

function declarations(selector: string): string {
  const rule = `${selector} {`;
  const start = component.indexOf(rule);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const end = component.indexOf('\n}', start);
  expect(end, selector).toBeGreaterThan(start);
  return component.slice(start + rule.length, end);
}

it('styles external text links without padding or hover background', () => {
  const rule = declarations('.md :deep(a:not(.mention-pill):not(:has(img)))');
  expect(rule).toContain('margin-inline: 0;');
  expect(rule).toContain('padding: 0;');
  expect(rule).toContain('text-decoration: none;');
  expect(rule).toContain('transition: color var(--duration-fast) var(--ease-out);');
  expect(rule).not.toContain('border-radius');
  expect(rule).not.toContain('box-decoration-break');
  expect(rule).not.toContain('background');

  const hover = declarations('.md :deep(a:not(.mention-pill):not(:has(img)):hover)');
  expect(hover).toContain('color: var(--color-link-hover);');
  expect(hover).toContain('text-decoration: underline;');
  expect(hover).not.toContain('background');
  expect(tokens).not.toContain('--markdown-link-hover-background');
  expect(tokens).not.toContain('--markdown-link-padding-block');
  expect(tokens).not.toContain('--markdown-link-padding-inline');
  expect(tokens).not.toContain('--markdown-link-radius');
});

it('shares the hyperlink blue ink and baseline geometry across file path links, mention pills and hyperlinks', () => {
  expect(sharedStyles).toContain('--color-link: light-dark(#0a5ad0, #3393ff);');
  expect(sharedStyles).toContain('--p-pill-fg: var(--color-link);');
  expect(sharedStyles).toContain('--p-pill-icon: var(--color-link);');
  expect(tokens).toContain('--markdown-link-color: var(--color-link);');

  const fileLink = declarations('.md :deep(.md-file-link)');
  expect(fileLink).toContain('align-items: baseline;');
  expect(fileLink).toContain('vertical-align: baseline;');
  expect(fileLink).toContain('background: transparent;');
  expect(fileLink).not.toContain('box-shadow');
  expect(fileLink).toContain('color: var(--p-pill-fg);');
  expect(fileLink).toContain('margin-inline: 0;');
  expect(fileLink).toContain('padding: 0;');
  expect(fileLink).toContain('gap: var(--space-05);');
  expect(fileLink).toContain('white-space: nowrap;');
  expect(declarations('.md :deep(.md-file-link .mention-pill-name)')).toContain('max-width: none;');

  const mentionRule = '.mention-pill,\n.attachment-pill,\n.quote-pill {';
  const start = sharedStyles.indexOf(mentionRule);
  expect(start).toBeGreaterThanOrEqual(0);
  const shared = sharedStyles.slice(start, sharedStyles.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  expect(shared).toContain('align-items: baseline;');
  expect(shared).toContain('vertical-align: baseline;');
  expect(shared).not.toContain('background');
  expect(shared).not.toContain('border');
  expect(shared).toContain('font-weight: inherit;');
  expect(shared).not.toContain('--weight-ui-strong');
  expect(shared).toContain('color: var(--p-pill-fg);');
  expect(shared).toContain('margin-inline: 0;');
  expect(shared).toContain('padding-inline: 0;');
  expect(shared).not.toContain('padding-inline: var(--space-05)');
  expect(shared).toContain('gap: var(--space-05);');

  const commentSepStart = sharedStyles.indexOf('.quote-pill-comment::before {');
  expect(commentSepStart).toBeGreaterThanOrEqual(0);
  const commentSep = sharedStyles.slice(commentSepStart, sharedStyles.indexOf('\n}', commentSepStart));
  expect(commentSep).toContain('margin-inline: var(--space-05);');

  const mdMention = declarations('.md :deep(a.mention-pill)');
  expect(mdMention).not.toContain('--markdown-secondary-icon-color');
});

it('keeps missing and error pill status colors when selected in the composer', () => {
  expect(composerComponent).toContain('.ph :deep(.mention-pill:not(.mention-missing).ProseMirror-selectednode),');
  expect(composerComponent).toContain('.ph :deep(.attachment-pill:not(.attachment-missing):not(.attachment-error).ProseMirror-selectednode),');
});

it('preserves basic link styling for image links and scopes hover treatment to text links', () => {
  const base = declarations('.md :deep(a)');
  expect(base).toContain('color: var(--markdown-link-color);');
  expect(base).toContain('text-decoration: underline;');
  expect(base).toContain('text-underline-offset: auto;');

  const text = declarations('.md :deep(a:not(.mention-pill):not(:has(img)))');
  expect(text).toContain('text-decoration: none;');
  expect(declarations('.md :deep(a.mention-pill:hover)')).toContain('color: var(--color-link-hover);');
  for (const selector of ['.md :deep(a.mention-file:hover),\n.md :deep(a.mention-skill:not(.mention-inert):hover)', '.md :deep(.md-file-link:hover)']) {
    expect(declarations(selector)).toContain('text-decoration: underline;');
  }
  expect(declarations('.md :deep(.md-file-link:hover)')).toContain('color: var(--color-link-hover);');
  expect(declarations('.md :deep(a.mention-folder:hover)')).toContain('text-decoration: none;');
});
