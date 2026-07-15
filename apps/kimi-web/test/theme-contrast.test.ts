import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const composer = readFileSync(new URL('../src/components/chat/Composer.vue', import.meta.url), 'utf8');
const switchComponent = readFileSync(new URL('../src/components/ui/Switch.vue', import.meta.url), 'utf8');
const designTokens = css.slice(css.indexOf('DESIGN TOKENS v2'));

function declarationBlock(source: string, selector: string): string {
  const selectorIndex = source.indexOf(`${selector} {`);
  expect(selectorIndex).toBeGreaterThanOrEqual(0);
  const openBrace = source.indexOf('{', selectorIndex);
  const closeBrace = source.indexOf('}', openBrace);
  return source.slice(openBrace + 1, closeBrace);
}

describe('dark mono theme contrast', () => {
  it('defines a stable light foreground for dark overlays', () => {
    expect(declarationBlock(designTokens, ':root')).toMatch(/--color-text-inverse:\s*#ffffff;/);
  });

  it.each(['.att-lightbox-name', '.att-lightbox-close'])('keeps %s readable on the dark overlay', (selector) => {
    expect(declarationBlock(composer, selector)).toMatch(/color:\s*var\(--color-text-inverse\);/);
  });

  it.each([
    ['.ui-switch__thumb', '--color-text-inverse'],
    ['.ui-switch.is-on .ui-switch__thumb', '--color-text-on-accent'],
  ])('uses %s background token %s', (selector, token) => {
    expect(declarationBlock(switchComponent, selector)).toMatch(new RegExp(`background:\\s*var\\(${token}\\);`));
  });

  it.each([
    'html[data-color-scheme="dark"][data-accent="mono"]',
    'html[data-color-scheme="system"][data-accent="mono"]',
  ])('uses dark text on the near-white accent for %s', (selector) => {
    expect(declarationBlock(css, selector)).toMatch(/--color-text-on-accent:\s*#171717;/);
  });
});
