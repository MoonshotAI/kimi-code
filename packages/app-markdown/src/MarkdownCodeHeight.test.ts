// @vitest-environment jsdom
import { compileStyle, parse } from 'vue/compiler-sfc';
import { afterEach, beforeEach, expect, it } from 'vitest';
import source from './Markdown.vue?raw';

const SCOPE = 'data-v-test';
let style: HTMLStyleElement;

beforeEach(() => {
  const { descriptor } = parse(source);
  style = document.createElement('style');
  style.textContent = descriptor.styles
    .map(block => compileStyle({ source: block.content, filename: 'Markdown.vue', id: SCOPE, scoped: block.scoped }).code)
    .join('\n');
  document.head.append(style);
});

afterEach(() => {
  style.remove();
  document.body.innerHTML = '';
});

function render(html: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'md';
  root.setAttribute(SCOPE, '');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

it('caps every code block form at the shared code max height', () => {
  const root = render(`
    <div class="code-block-container"><div class="code-block-shell-content"><pre class="code-pre-fallback"></pre></div></div>
    <div class="code-block-container"><div class="code-block-shell-content"><div class="code-editor-layer"><div class="code-editor-container"></div></div></div></div>
    <div class="diff-wrap" ${SCOPE}><pre class="diff-pre" ${SCOPE}></pre></div>
  `);
  for (const el of root.querySelectorAll<HTMLElement>('.code-block-shell-content, .code-editor-container, .diff-pre')) {
    expect(getComputedStyle(el).maxHeight).toBe('var(--markdown-code-max-height)');
  }
  expect(getComputedStyle(root.querySelector('.code-editor-container')!).height).toBe('auto');
});

it('gives the pending fallback pre the highlighted code metrics', () => {
  const root = render(`<div class="code-block-container"><div class="code-block-shell-content"><pre class="code-pre-fallback"></pre></div></div>`);
  const pre = getComputedStyle(root.querySelector('pre')!);
  expect(pre.paddingTop).toBe('0px');
  expect(pre.paddingBottom).toBe('var(--markdown-code-padding-bottom)');
  expect(pre.fontSize).toBe('var(--markdown-code-font-size)');
  expect(pre.lineHeight).toBe('var(--markdown-code-line-height)');
});

it('hides the native scrollbar on the pending fallback pre so overflowing lines keep its height', () => {
  const root = render(`<div class="code-block-container"><div class="code-block-shell-content"><pre class="code-pre-fallback"></pre></div></div>`);
  expect(getComputedStyle(root.querySelector('pre')!).getPropertyValue('scrollbar-width')).toBe('none');
});
