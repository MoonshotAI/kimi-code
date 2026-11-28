// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { UIQuestion } from '@moonshot-ai/app-core/client/types';

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/client')>();
  return {
    ...actual,
    useKimiWebClient: () => ({
      goal: ref(null),
      planMode: ref(false),
      planArmed: ref(false),
      controlGoal: vi.fn(),
      togglePlanMode: vi.fn(),
      cancelTask: vi.fn(),
      dismissQuestion: vi.fn(),
    }),
  };
});

vi.mock('@moonshot-ai/app-client/composables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/composables')>();
  return {
    ...actual,
    useConfirmDialog: () => ({ confirm: vi.fn(), isConfirmOpen: ref(false) }),
    useAppDialogs: () => ({ anyOverlayOpen: ref(false) }),
  };
});

vi.mock('@moonshot-ai/app-core/composables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-core/composables')>();
  return { ...actual, useAppearance: () => ({ fontScale: ref('medium') }) };
});

vi.mock('@moonshot-ai/app-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-components')>();
  return { ...actual, Composer: { render: () => null } };
});

vi.mock('@moonshot-ai/app-markdown', () => ({ Markdown: { render: () => null } }));

import { panelApiKey } from '@moonshot-ai/app-client/panel';
import ChatDock from '../../src/renderer/components/chat/ChatDock.vue';

const OTHER_TEXT = 'Ship it behind a feature flag';
const question: UIQuestion = {
  questionId: 'question-1',
  sessionId: 'session-1',
  toolCallId: 'call-1',
  questions: [
    {
      id: 'framework',
      question: 'Which framework should we use?',
      options: [
        { id: 'vue', label: 'Vue' },
        { id: 'react', label: 'React' },
      ],
      multiSelect: false,
      allowOther: true,
    },
    {
      id: 'release',
      question: 'How should we release it?',
      options: [
        { id: 'all', label: 'All at once' },
        { id: 'canary', label: 'Canary first' },
      ],
      multiSelect: false,
      allowOther: true,
    },
  ],
};

let app: App | null = null;
let host: HTMLDivElement;

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent?.includes(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.restoreAllMocks();
});

describe('ChatDock pending questions', () => {
  it('preserves the current step and answers when the same question is replayed after a reset', async () => {
    const current = ref<UIQuestion | undefined>(question);
    const activeKeydownListeners = new Set<unknown>();
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'keydown') activeKeydownListeners.add(listener);
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation((type, listener) => {
      if (type === 'keydown') activeKeydownListeners.delete(listener);
    });
    app = createApp({
      setup: () => () => h(ChatDock, {
        dockPanel: null,
        bashTasks: [],
        subagentTasks: [],
        bashRunning: 0,
        subagentRunning: 0,
        todoDoneCount: 0,
        hasDockWork: false,
        todos: [],
        pendingQuestion: current.value,
      }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(IconResolverKey, name => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.provide(panelApiKey, undefined);
    app.mount(host);
    await nextTick();

    host.querySelector<HTMLElement>('.qopt')!.click();
    await nextTick();
    button('Next question').click();
    await nextTick();
    expect(host.querySelector('.qtitle')?.textContent).toBe('How should we release it?');
    const input = host.querySelector<HTMLInputElement>('.other-input')!;
    input.value = OTHER_TEXT;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(button('Submit').disabled).toBe(false);
    expect(activeKeydownListeners.size).toBe(1);

    current.value = undefined;
    await nextTick();
    expect(host.querySelector('.qcard')).toBeNull();
    expect(activeKeydownListeners.size).toBe(0);

    current.value = { ...question };
    await nextTick();
    expect(host.querySelector('.qtitle')?.textContent).toBe('How should we release it?');
    expect(button('Previous question').disabled).toBe(false);
    expect(button('Submit').disabled).toBe(false);
    expect(activeKeydownListeners.size).toBe(1);

    button('Previous question').click();
    await nextTick();
    expect(host.querySelector('.qtitle')?.textContent).toBe('Which framework should we use?');
    expect(host.querySelector('.qopt.selected')?.textContent).toContain('Vue');
    button('Next question').click();
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('.other-input')?.value).toBe(OTHER_TEXT);
    expect(activeKeydownListeners.size).toBe(1);

    current.value = { ...question, questionId: 'question-2' };
    await nextTick();
    expect(host.querySelector('.qtitle')?.textContent).toBe('Which framework should we use?');
    expect(host.querySelector('.qopt.selected')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('.other-input')?.value).toBe('');
    expect(activeKeydownListeners.size).toBe(1);
  });
});
