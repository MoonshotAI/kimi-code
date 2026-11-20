// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-markdown', async () => {
  const vue = await import('vue');
  return {
    Markdown: vue.defineComponent({
      name: 'Markdown',
      props: ['text'],
      setup: (props) => () => vue.h('div', { class: 'msg' }, String(props.text ?? '')),
    }),
    createHistoryImageCache: () => ({}),
    HistoryImageCacheKey: Symbol('historyImageCache'),
  };
});

vi.mock('@moonshot-ai/app-client/client', async () => {
  const vue = await import('vue');
  return {
    useKimiWebClient: () => ({
      experimentalFlags: vue.ref({}),
      activeSessionId: vue.ref(null),
      resolveImageUrl: (src: string) => src,
      skills: vue.ref([]),
      notify: vi.fn(),
      detachTask: vi.fn(),
      unqueue: vi.fn(),
    }),
    getKimiWebApi: () => ({}),
    t: (key: string) => key,
  };
});

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';
import type { TurnFileHistoryChange } from '@moonshot-ai/app-core/api';
import { FetchTurnFileChangesKey, type FetchTurnFileChanges, type TurnFileChangesResult } from '@moonshot-ai/app-client/contracts';
import ChatPane from '../src/chat/ChatPane.vue';

const write = (id: string, path: string) => ({ id, name: 'write', arg: JSON.stringify({ path, content: '' }), status: 'ok', output: ['done'] });

function conversation(state: 'running' | 'completed'): ChatTurn[] {
  return [
    { id: 'u1', role: 'user', no: 1, text: 'Question' },
    {
      id: 'a1', role: 'assistant', no: 1, daemonTurnId: 1, daemonTurnState: state, text: 'Final answer',
      tools: [write('t1', 'a.ts'), write('t2', 'b.ts')],
    },
  ] as unknown as ChatTurn[];
}

const turns = ref<ChatTurn[]>([]);
const session = ref('s1');

let app: App | null = null;
let host: HTMLDivElement;
let resolve: (value: TurnFileChangesResult) => void;

function mount(state: 'running' | 'completed'): void {
  turns.value = conversation(state);
  session.value = 's1';
  const fetcher = Object.assign(
    vi.fn(() => new Promise<TurnFileChangesResult>((done) => { resolve = done; })),
    { getSignal: () => undefined },
  ) as FetchTurnFileChanges;
  app = createApp({ render: () => h(ChatPane, { turns: turns.value, sessionId: session.value, windowHistory: false }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(FetchTurnFileChangesKey, fetcher);
  app.mount(host);
}

async function finishTurn(): Promise<void> {
  turns.value = conversation('completed');
  await nextTick();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await nextTick();
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

it('reserves the turn diff card while changes load and fills it in place', async () => {
  mount('running');
  await nextTick();
  await finishTurn();
  const card = host.querySelector('.turn-files');
  expect(card?.getAttribute('aria-busy')).toBe('true');
  expect(card?.querySelectorAll('.tf-row')).toHaveLength(2);

  const changes: TurnFileHistoryChange[] = [
    { path: 'a.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'b.ts', status: 'modified', additions: 2, deletions: 0 },
  ];
  resolve(changes);
  await settle();
  const filled = host.querySelector('.turn-files');
  expect(filled?.hasAttribute('aria-busy')).toBe(false);
  expect(filled?.querySelectorAll('.tf-row')).toHaveLength(2);
  expect(filled?.querySelector('.tf-add')?.textContent).toBe('+5');
});

it('collapses the reserved card when the turn has no recorded changes', async () => {
  mount('running');
  await nextTick();
  await finishTurn();
  expect(host.querySelector('.turn-files')).not.toBeNull();
  resolve([]);
  await settle();
  expect(host.querySelector('.turn-files')).toBeNull();
});

it('does not reserve a card for turns that had already settled when the session opened', async () => {
  mount('completed');
  await nextTick();
  expect(host.querySelector('.turn-files')).toBeNull();

  resolve([{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }]);
  await settle();
  expect(host.querySelector('.turn-files')?.hasAttribute('aria-busy')).toBe(false);
});

it('does not reserve a card for a settled turn that reuses a live turn id from the previous session', async () => {
  mount('running');
  await nextTick();
  session.value = 's2';
  turns.value = conversation('completed');
  await nextTick();
  expect(host.querySelector('.turn-files')).toBeNull();
});
