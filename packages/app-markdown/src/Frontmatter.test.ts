import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import Frontmatter from './Frontmatter.vue';

async function render(source: string, locale = 'en'): Promise<string> {
  const app = createSSRApp({ render: () => h(Frontmatter, { source }) });
  app.use(createKimiI18n({ locale }));
  return renderToString(app);
}

describe('Frontmatter', () => {
  it('renders a localized definition list with array badges', async () => {
    const html = await render('created: 2026-09-09\ntags: [kimi-code, browser]', 'zh');
    expect(html).toContain('aria-label="元数据"');
    expect(html).toMatch(/<dt[^>]*>created<\/dt>/);
    expect(html).toContain('2026-09-09');
    expect(html.match(/ui-badge--soft/g)).toHaveLength(2);
    expect(html).not.toContain('metadata-source');
  });

  it('escapes markup in both structured metadata and raw fallback', async () => {
    for (const source of ['html: <img src=x onerror=alert(1)>', '<img src=x onerror=alert(1)>']) {
      const html = await render(source);
      expect(html).toContain('&lt;img');
      expect(html).not.toContain('<img');
    }
  });

  it('preserves invalid YAML as readable source', async () => {
    const html = await render('tags: [unfinished');
    expect(html).toContain('aria-label="Metadata"');
    expect(html).toContain('metadata-source');
    expect(html).toContain('tags: [unfinished');
  });
});
