import { defineComponent, h, provide } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-markdown', async () => {
  const vue = await import('vue');
  return {
    Markdown: vue.defineComponent({ name: 'Markdown', setup: () => () => vue.h('div') }),
  };
});

vi.mock('vue-i18n', async (importActual) => {
  const actual = await importActual<typeof import('vue-i18n')>();
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) };
});

import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { ChatPane } from '@moonshot-ai/app-components';
import { TurnFilesSummary } from '@moonshot-ai/app-components';
import type { TurnFileChange } from '@moonshot-ai/app-components';

const editChange: TurnFileChange = {
  path: '/repo/src/a.ts',
  added: 3,
  removed: 1,
};
const writeChange: TurnFileChange = {
  path: '/repo/src/b.ts',
  added: 0,
  removed: 0,
};

function propDefault(component: unknown, name: string): unknown {
  const props = (component as { props?: Record<string, { default?: unknown }> }).props;
  return props?.[name]?.default;
}

function renderSummary(props: Record<string, unknown>): Promise<string> {
  const Host = defineComponent(() => {
    provide(panelApiKey, undefined);
    return () => h(TurnFilesSummary as never, { cwd: '/repo', turnId: 'turn_1', ...props });
  });
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
    expect(html).not.toContain('aria-label');
  });

  it('hides the header totals when any row has no countable lines', async () => {
    const binaryChange: TurnFileChange = {
      path: '/repo/assets/logo.png',
      added: 0,
      removed: 0,
      binary: true,
    };
    const withBinary = await renderSummary({ changes: [editChange, binaryChange] });
    expect(withBinary).not.toContain('diffbar');
    const allCountable = await renderSummary({ changes: [editChange, writeChange] });
    expect(allCountable).toContain('diffbar');
  });
});
