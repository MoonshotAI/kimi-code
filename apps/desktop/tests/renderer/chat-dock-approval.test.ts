// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/client')>();
  return {
    ...actual,
    useKimiWebClient: () => ({
      goal: ref(null),
      planMode: ref(false),
      planArmed: ref(false),
      status: ref({ cwd: '/workspace' }),
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

const FEEDBACK = 'Put it in the README instead';
const approval = (approvalId: string) => ({
  approvalId,
  block: { kind: 'shell' as const, command: 'echo hello', language: 'bash' },
});

let app: App | null = null;
let host: HTMLDivElement;

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent?.includes(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function pressKey(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

describe('ChatDock pending approvals', () => {
  it('keeps an open feedback form across a reset and re-add, and a resolved approval stays gone', async () => {
    const current = ref<ReturnType<typeof approval> | undefined>(approval('approval-1'));
    const decisions: unknown[][] = [];
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
        pendingApproval: current.value,
        onApproval: (...args: unknown[]) => decisions.push(args),
      }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(IconResolverKey, name => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.provide(panelApiKey, undefined);
    app.mount(host);
    await nextTick();

    button('Feedback').click();
    await nextTick();
    const textarea = host.querySelector('textarea')!;
    textarea.value = FEEDBACK;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();

    current.value = undefined;
    await nextTick();
    expect(host.querySelector('.appr')).toBeNull();
    pressKey('1');
    expect(decisions).toEqual([]);

    current.value = approval('approval-1');
    await nextTick();
    await nextTick();
    expect(host.querySelector('textarea')?.value).toBe(FEEDBACK);
    expect(document.activeElement).toBe(host.querySelector('textarea'));

    (await vi.waitFor(() => button('Reject with feedback'))).click();
    await nextTick();
    expect(decisions).toEqual([['approval-1', { decision: 'rejected', feedback: FEEDBACK }]]);

    current.value = undefined;
    await nextTick();
    expect(host.querySelector('.appr')).toBeNull();
    pressKey('1');
    expect(decisions).toHaveLength(1);

    current.value = approval('approval-2');
    await nextTick();
    expect(host.querySelector('textarea')).toBeNull();
    pressKey('1');
    expect(decisions[1]).toEqual(['approval-2', { decision: 'approved' }]);
  });
});
