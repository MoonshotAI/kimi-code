import { mount, type VueWrapper } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { nextTick } from 'vue';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MarkdownRender } from 'markstream-vue';

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

function visibleByVShow(wrapper: VueWrapper): boolean {
  return !/\bdisplay:\s*none\b/.test(wrapper.attributes('style') ?? '');
}

function isSettled(wrapper: VueWrapper): boolean {
  if (wrapper.findAll('.node-placeholder').length > 0) return false;
  const visibleSkeletons = wrapper.findAll('.code-loading-placeholder').filter(visibleByVShow);
  if (visibleSkeletons.length > 0) return false;
  return wrapper.findAll('[data-node-index]').length > 0;
}

// Poll until markstream finishes rendering the real nodes. A fixed timeout was
// flaky under full-suite parallel load: markstream's shiki/parse queue can take
// longer than 1s when the CPU is busy, leaving `[data-node-index]` empty.
async function waitForSettled(wrapper: VueWrapper, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await nextTick();
    if (isSettled(wrapper)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // One last check so the assertion below produces a useful diff on failure.
  await nextTick();
}

describe('markdown streaming placeholders', () => {
  it('keeps settled code blocks mounted instead of viewport-deferred', () => {
    const wrapper = mount(Markdown, {
      attachTo: document.body,
      props: { text: '```ts\nconst ready = true;\n```', streaming: false },
      global: { plugins: [i18n], provide: { resolveImage: undefined } },
    });
    mounted.push(wrapper);

    const renderer = wrapper.findComponent(MarkdownRender);
    expect(renderer.exists()).toBe(true);
    expect(renderer.props('batchRendering')).toBe(true);
    expect(renderer.props('deferNodesUntilVisible')).toBe(false);
  });

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

    await waitForSettled(wrapper);

    expect(wrapper.findAll('.node-placeholder')).toHaveLength(0);
    const visibleCodeSkeletons = wrapper.findAll('.code-loading-placeholder').filter(visibleByVShow);
    expect(visibleCodeSkeletons).toHaveLength(0);
    expect(wrapper.findAll('[data-node-index]').length).toBeGreaterThan(0);
  }, 10000);
});
