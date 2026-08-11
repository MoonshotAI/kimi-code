import { defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';

// ChatPane's import graph reaches markstream (KaTeX worker), which can't load
// under node — only its props metadata is needed here, so stub Markdown out.
vi.mock('@moonshot-ai/app-markdown', async () => {
  const vue = await import('vue');
  return {
    Markdown: vue.defineComponent({ name: 'Markdown', setup: () => () => vue.h('div') }),
  };
});

// The summary only needs a `t` pass-through; everything else (createI18n for
// the transitive app-i18n import) stays real.
vi.mock('vue-i18n', async (importActual) => {
  const actual = await importActual<typeof import('vue-i18n')>();
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) };
});

import ChatPane from '../../src/renderer/components/chat/ChatPane.vue';
import TurnFilesSummary from '../../src/renderer/components/chat/TurnFilesSummary.vue';
import type { TurnFileChange } from '../../src/renderer/components/chatTurnRendering';

const editChange: TurnFileChange = {
  path: '/repo/src/a.ts',
  added: 3,
  removed: 1,
  hasWrite: false,
  statsIncomplete: false,
  diff: null,
};
const writeChange: TurnFileChange = {
  path: '/repo/src/b.ts',
  added: 0,
  removed: 0,
  hasWrite: true,
  statsIncomplete: true,
  diff: null,
};

function propDefault(component: unknown, name: string): unknown {
  const props = (component as { props?: Record<string, { default?: unknown }> }).props;
  return props?.[name]?.default;
}

function renderSummary(props: Record<string, unknown>): Promise<string> {
  // Untyped on purpose: spread test props don't satisfy the SFC's vnode-prop
  // generics, and the assertion targets rendered HTML, not the prop types.
  const Host = defineComponent(() => () => h(TurnFilesSummary as never, { cwd: '/repo', ...props }));
  return renderToString(h(Host));
}

describe('TurnFilesSummary interactivity', () => {
  it('defaults the interactive flag to true at both boundaries', () => {
    expect(propDefault(TurnFilesSummary, 'interactive')).toBe(true);
    expect(propDefault(ChatPane, 'turnFilesInteractive')).toBe(true);
  });

  it('renders rows as buttons when interactive is not passed', async () => {
    const html = await renderSummary({ changes: [editChange, writeChange] });
    expect(html).toMatch(/<button[^>]*class="[^"]*tf-file/);
    expect(html).not.toMatch(/<span[^>]*class="[^"]*tf-file/);
  });

  it('renders rows as plain text only when interactive is explicitly false', async () => {
    const html = await renderSummary({ changes: [editChange], interactive: false });
    expect(html).toMatch(/<span[^>]*class="[^"]*tf-file/);
    expect(html).not.toMatch(/<button[^>]*class="[^"]*tf-file/);
  });
});
