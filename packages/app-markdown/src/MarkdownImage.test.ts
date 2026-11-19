import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { expect, it } from 'vitest';
import MarkdownImage from './MarkdownImage.vue';

it('uses explicit titles for captions and leaves alt-only images unobscured', async () => {
  for (const title of [null, '', 'A caption']) {
    const app = createSSRApp({ render: () => h(MarkdownImage, {
      node: { type: 'image', src: 'https://example.com/image.png', alt: 'Alternative text', title, raw: '' },
    }) });
    const html = await renderToString(app);
    expect(html.includes('data-caption=')).toBe(Boolean(title));
    expect(html).toContain('alt="Alternative text"');
    if (title) expect(html).toContain('data-caption="A caption"');
  }
});
