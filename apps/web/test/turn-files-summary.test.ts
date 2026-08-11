import { describe, expect, it, vi } from 'vitest';

// ChatPane's import graph reaches markstream (KaTeX worker), which can't load
// under node — only its props metadata is needed here, so stub Markdown out.
vi.mock('@moonshot-ai/app-markdown', async () => {
  const vue = await import('vue');
  return {
    Markdown: vue.defineComponent({ name: 'Markdown', setup: () => () => vue.h('div') }),
  };
});

import ChatPane from '../src/components/chat/ChatPane.vue';
import TurnFilesSummary from '../src/components/chat/TurnFilesSummary.vue';

function propDefault(component: unknown, name: string): unknown {
  const props = (component as { props?: Record<string, { default?: unknown }> }).props;
  return props?.[name]?.default;
}

describe('TurnFilesSummary interactivity', () => {
  it('defaults the interactive flag to true at both boundaries', () => {
    expect(propDefault(TurnFilesSummary, 'interactive')).toBe(true);
    expect(propDefault(ChatPane, 'turnFilesInteractive')).toBe(true);
  });
});
