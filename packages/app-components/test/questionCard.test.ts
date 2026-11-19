// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-markdown', async () => {
  const vue = await import('vue');
  return {
    Markdown: vue.defineComponent({
      name: 'Markdown',
      props: { text: { type: String, default: '' } },
      setup: (props) => () => vue.h('div', { class: 'md-stub' }, props.text),
    }),
  };
});

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { UIQuestion } from '@moonshot-ai/app-core/client/types';
import QuestionCard from '../src/chat/QuestionCard.vue';

let app: App | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
});

function question(options: { label: string; description?: string }[], multiSelect = false): UIQuestion {
  return {
    questionId: 'q-1',
    sessionId: 's-1',
    questions: [
      {
        id: 'q_0',
        question: 'Which database?',
        options: options.map((option, index) => ({ id: `opt_0_${index}`, ...option })),
        multiSelect,
      },
    ],
  };
}

async function selectedLabels(input: UIQuestion): Promise<string[]> {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(QuestionCard, { question: input }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  await nextTick();
  return [...host.querySelectorAll('.qopt.selected .qopt-label')].map((el) => el.textContent ?? '');
}

describe('QuestionCard recommended options', () => {
  it('preselects only the option whose label ends with the recommended marker', async () => {
    const selected = await selectedLabels(
      question([
        { label: 'SQLite', description: 'Not recommended for concurrent writes' },
        { label: 'Postgres (Recommended)' },
        { label: 'I recommend asking the team' },
      ]),
    );

    expect(selected).toEqual(['Postgres (Recommended)']);
  });

  it('accepts the full-width Chinese marker and ignores 推荐 elsewhere in the text', async () => {
    const selected = await selectedLabels(
      question([
        { label: '不推荐的方案' },
        { label: '方案 B（推荐）' },
        { label: '方案 C', description: '推荐给小团队' },
      ]),
    );

    expect(selected).toEqual(['方案 B（推荐）']);
  });

  it('preselects every marked option in a multi-select question', async () => {
    const selected = await selectedLabels(
      question(
        [
          { label: 'Lint (Recommended)' },
          { label: 'Typecheck' },
          { label: 'Tests (recommended)' },
        ],
        true,
      ),
    );

    expect(selected).toEqual(['Lint (Recommended)', 'Tests (recommended)']);
  });

  it('preselects nothing when no option is marked', async () => {
    const selected = await selectedLabels(question([{ label: 'Yes' }, { label: 'No' }]));

    expect(selected).toEqual([]);
  });
});
