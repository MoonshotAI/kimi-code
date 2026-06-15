import { mount, type VueWrapper } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { nextTick } from 'vue';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import Markdown from '../src/components/Markdown.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: {} },
  missingWarn: false,
  fallbackWarn: false,
});

let mounted: VueWrapper[] = [];

beforeAll(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

async function settleRender() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await nextTick();
}

function visibleByVShow(wrapper: VueWrapper): boolean {
  return !/\bdisplay:\s*none\b/.test(wrapper.attributes('style') ?? '');
}

describe('markdown streaming placeholders', () => {
  it('does not show markstream placeholders while a large message is streaming', async () => {
    const text = Array.from(
      { length: 480 },
      (_, i) => `Paragraph ${i}\n\n\`\`\`ts\nconst value${i} = ${i};\n\`\`\``,
    ).join('\n\n');

    const wrapper = mount(Markdown, {
      attachTo: document.body,
      props: { text, streaming: true },
      global: { plugins: [i18n], provide: { resolveImage: undefined } },
    });
    mounted.push(wrapper);

    await settleRender();

    expect(wrapper.findAll('.node-placeholder')).toHaveLength(0);
    const visibleCodeSkeletons = wrapper.findAll('.code-loading-placeholder').filter(visibleByVShow);
    expect(visibleCodeSkeletons).toHaveLength(0);
    expect(wrapper.findAll('[data-node-index]').length).toBeGreaterThan(0);
  });
});
