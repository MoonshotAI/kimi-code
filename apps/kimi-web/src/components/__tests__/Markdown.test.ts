// apps/kimi-web/src/components/__tests__/Markdown.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import i18n from '../../i18n';
import Markdown from '../Markdown.vue';

// Markdown uses vue-i18n (copy-button title); default locale is English.
const global = { plugins: [i18n] };

function render(text: string, streaming = false) {
  return mount(Markdown, { props: { text, streaming }, global });
}

// markstream-vue is an async component that parses + (for code) runs Shiki
// asynchronously. In jsdom we poll for a few hundred ms until the content
// settles. `settle()` flushes timers + microtasks repeatedly.
async function settle(rounds = 120, step = 20) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, step));
    await nextTick();
  }
}

describe('Markdown', () => {
  it('mounts and renders a paragraph', async () => {
    const w = render('Hello world paragraph');
    await settle();
    // markstream's root wrapper is present...
    expect(w.find('.markdown-renderer').exists()).toBe(true);
    // ...and the prose renders as a paragraph carrying the text.
    expect(w.find('p').exists()).toBe(true);
    expect(w.text()).toContain('Hello world paragraph');
  });

  it('renders inline code as a chip', async () => {
    const w = render('use `const x` here');
    await settle();
    const inline = w.find('code.inline-code');
    expect(inline.exists()).toBe(true);
    expect(inline.text()).toBe('const x');
  });

  it('renders a fenced code block with a header, language label and copy button', async () => {
    const w = render('```ts\nconst x = 1;\n```');
    await settle();
    expect(w.find('.code-block-container').exists()).toBe(true);
    // Built-in copy button (markstream renders it in the header).
    expect(w.find('.code-block-header button[aria-label="Copy"]').exists()).toBe(true);
    // Language label (markstream shows the display name, e.g. "TypeScript").
    expect(w.find('.code-header-title').text().toLowerCase()).toContain('type');
  });

  it('highlights a fenced code block with Shiki on a light theme', async () => {
    const w = render('```ts\nfunction add(a: number, b: number) {\n  return a + b;\n}\n```');
    await settle();
    const pre = w.find('pre.shiki');
    expect(pre.exists()).toBe(true);
    // github-light renders on a light (#fff) surface, never a dark code theme.
    expect(pre.attributes('style') ?? '').toContain('#fff');
    // Shiki emits per-token coloured spans (e.g. the `function` keyword).
    expect(pre.html()).toMatch(/style="color:/);
  });

  it('sanitizes raw HTML in prose (no injection)', async () => {
    const w = render('Hello <script>alert(1)</script><img src=x onerror=alert(2)> world');
    await settle();
    // markstream sanitizes: no executable <script> and no event-handler image.
    expect(w.find('script').exists()).toBe(false);
    const img = w.find('img');
    if (img.exists()) expect(img.attributes('onerror')).toBeUndefined();
    expect(w.text()).toContain('Hello');
    expect(w.text()).toContain('world');
  });

  it('renders a ```diff fence locally with coloured + / - lines and preserved content', async () => {
    const w = render('```diff\n context line\n+added line\n-removed line\n```');
    await settle();
    // Diff fences are rendered by the local renderer, not markstream.
    const wrap = w.find('.diff-wrap');
    expect(wrap.exists()).toBe(true);
    const added = wrap.find('.diff-add');
    const removed = wrap.find('.diff-del');
    expect(added.exists()).toBe(true);
    expect(removed.exists()).toBe(true);
    // Markers + content preserved (markstream would strip these / drop the - line).
    expect(added.text()).toContain('+added line');
    expect(removed.text()).toContain('-removed line');
    expect(wrap.find('.diff-ctx').exists()).toBe(true);
    // Local copy button.
    expect(wrap.find('.diff-copy').exists()).toBe(true);
  });
});
