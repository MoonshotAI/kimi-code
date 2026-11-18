import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import IconButton from '../../app-ui/src/components/ui/IconButton.vue';

describe('icon button toggle state', () => {
  it('preserves ordinary button semantics unless a pressed state is supplied', async () => {
    const html = await renderToString(createSSRApp(IconButton, { label: 'Refresh' }));
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('is-pressed');
  });

  it.each([true, false])('renders the controlled pressed state %s', async (pressed) => {
    const html = await renderToString(createSSRApp(IconButton, { label: 'Annotate page', pressed }));
    expect(html).toContain(`aria-pressed="${pressed}"`);
    expect(html.includes('is-pressed')).toBe(pressed);
  });
});
