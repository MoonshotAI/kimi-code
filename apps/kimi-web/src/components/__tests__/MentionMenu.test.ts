// apps/kimi-web/src/components/__tests__/MentionMenu.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import MentionMenu from '../MentionMenu.vue';
import type { FileItem } from '../MentionMenu.vue';

const global = { plugins: [i18n] };

const items: FileItem[] = [
  { name: 'client.ts', path: 'src/api/client.ts' },
  { name: 'README.md', path: 'docs/README.md' },
  { name: 'logo.png', path: 'assets/logo.png' },
  { name: 'components', path: 'src/components/' },
  { name: 'LICENSE', path: 'LICENSE' },
];

function render(overrides: Partial<{ items: FileItem[]; activeIndex: number; loading: boolean }> = {}) {
  return mount(MentionMenu, {
    props: { items, activeIndex: 0, loading: false, ...overrides },
    global,
  });
}

describe('MentionMenu', () => {
  it('renders a file-type glyph for every row', () => {
    const w = render();
    const rows = w.findAll('.mention-item');
    expect(rows.length).toBe(items.length);
    for (const row of rows) {
      const icon = row.find('.mention-icon');
      expect(icon.exists()).toBe(true);
      // Each glyph is a line-SVG.
      expect(icon.find('svg').exists()).toBe(true);
    }
  });

  it('still shows the path text and supports selection', async () => {
    const w = render();
    const first = w.findAll('.mention-item')[0]!;
    expect(first.find('.mention-path').text()).toBe('src/api/client.ts');
    await first.trigger('mousedown');
    expect(w.emitted('select')?.[0]).toEqual([items[0]]);
  });

  it('distinguishes icon kinds (folder/doc/image differ from code)', () => {
    const w = render();
    const svgs = w.findAll('.mention-item .mention-icon').map((i) => i.html());
    // The five rows are: code, doc, image, folder, generic — at least 4 distinct SVGs.
    const distinct = new Set(svgs);
    expect(distinct.size).toBeGreaterThanOrEqual(4);
  });

  it('renders one consistently-sized inline SVG per row', () => {
    const w = render();
    for (const icon of w.findAll('.mention-icon')) {
      const svg = icon.find('svg');
      expect(svg.exists()).toBe(true);
      expect(svg.attributes('viewBox')).toBe('0 0 16 16');
    }
  });

  // Each extension category should map to its own glyph. We assert by rendering
  // representative rows and grouping rows that share an identical icon SVG.
  it('maps every extension category to the correct icon', () => {
    // [path, expected category key] — rows in the same category share one SVG.
    const cases: Array<[string, string]> = [
      ['src/api/client.ts', 'code'],
      ['app.vue', 'code'],
      ['main.py', 'code'],
      ['lib.rs', 'code'],
      ['data.json', 'code'],
      ['style.css', 'code'],
      ['index.html', 'code'],
      ['schema.sql', 'code'],
      ['config.yaml', 'code'],
      ['run.sh', 'code'],
      ['README.md', 'doc'],
      ['notes.txt', 'doc'],
      ['spec.pdf', 'doc'],
      ['logo.png', 'image'],
      ['photo.jpg', 'image'],
      ['icon.svg', 'image'],
      ['anim.gif', 'image'],
      ['pic.webp', 'image'],
      ['src/components/', 'folder'],
      ['LICENSE', 'generic'],
      ['Makefile', 'generic'],
    ];
    const rowItems: FileItem[] = cases.map(([path]) => ({
      path,
      name: path.replace(/\/$/, '').split('/').pop() || path,
    }));
    const w = render({ items: rowItems });
    const icons = w.findAll('.mention-icon').map((i) => i.html());

    // Build category → set-of-SVGs. Each category must use exactly one glyph,
    // and the glyphs across categories must all differ.
    const byCat = new Map<string, Set<string>>();
    cases.forEach(([, cat], i) => {
      const set = byCat.get(cat) ?? new Set<string>();
      set.add(icons[i]!);
      byCat.set(cat, set);
    });

    for (const [cat, set] of byCat) {
      expect(set.size, `category "${cat}" should use a single glyph`).toBe(1);
    }
    const perCategoryGlyph = [...byCat.values()].map((s) => [...s][0]!);
    expect(new Set(perCategoryGlyph).size, 'each category needs a distinct glyph').toBe(byCat.size);
  });
});
