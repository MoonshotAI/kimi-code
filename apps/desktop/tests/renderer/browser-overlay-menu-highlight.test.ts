import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { expect, it } from 'vitest';
import BrowserOverlayMenuEntry from '../../src/renderer/components/browser-overlay/BrowserOverlayMenuEntry.vue';
import type { BrowserOverlayMenuItem } from '../../src/shared/browser-overlay';

async function render(item: BrowserOverlayMenuItem, highlightQuery?: string): Promise<string> {
  const html = await renderToString(createSSRApp({ render: () => h(BrowserOverlayMenuEntry, { item, iconGutter: true, listbox: true, highlightQuery }) }));
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/ data-v-[0-9a-f]+/g, '');
}

it('computes highlights from the query and renders them as escaped text segments', async () => {
  const html = await render({
    kind: 'item', id: 'history-0', icon: 'history',
    label: 'University of Oregon <b>to</b> St. Louis',
    description: 'https://www.google.com/…/@40.9125081,-106.2944017?q=oregon&x=<i>',
  }, 'OREGON');
  expect(html).toContain('<span class="overlay-menu-label">University of <strong class="overlay-menu-match">Oregon</strong> &lt;b&gt;to&lt;/b&gt; St. Louis</span>');
  expect(html).toContain('<span class="overlay-menu-description">https://www.google.com/…/@40.9125081,-106.2944017?q=<strong class="overlay-menu-match">oregon</strong>&amp;x=&lt;i&gt;</span>');
  expect(html.match(/<strong/g)).toHaveLength(2);
  expect(html).not.toContain('<b>');
  expect(html).not.toContain('<i>');
});

it('highlights each query word and renders plain text without a query', async () => {
  const item = { kind: 'item' as const, id: 'history-1', label: 'Oregon.gov Home Page', description: 'https://oregon.gov/' };
  const words = await render(item, 'home  oregon');
  expect(words).toContain('<span class="overlay-menu-label"><strong class="overlay-menu-match">Oregon</strong>.gov <strong class="overlay-menu-match">Home</strong> Page</span>');
  expect(words).toContain('<span class="overlay-menu-description">https://<strong class="overlay-menu-match">oregon</strong>.gov/</span>');
  for (const query of [undefined, '', '  ']) {
    const html = await render(item, query);
    expect(html).toContain('Oregon.gov Home Page');
    expect(html).not.toContain('<strong');
  }
});
