// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const vue = await import('vue');
  return {
    ...actual,
    useKimiWebClient: () => ({
      activeSessionId: vue.ref<string | null>(null),
      activeWorkspaceId: vue.ref('ws-1'),
      activity: vue.ref('idle'),
      working: vue.ref(false),
      isStartingFirstPrompt: vue.ref(false),
      activeSessionEnvironment: vue.ref('local'),
      queued: vue.ref([]),
      searchFiles: vi.fn(async () => []),
      uploadImage: vi.fn(),
      status: vue.ref({ model: 'k2', permission: 'manual' }),
      thinking: vue.ref('high'),
      planMode: vue.ref(false),
      planArmed: vue.ref(false),
      swarmMode: vue.ref(false),
      towerMode: vue.ref(false),
      planModeAvailable: vue.ref(true),
      swarmModeAvailable: vue.ref(true),
      towerModeAvailable: vue.ref(true),
      goalModeAvailable: vue.ref(true),
      goalMode: vue.ref(false),
      goal: vue.ref(null),
      activationBadges: vue.ref([]),
      models: vue.ref([]),
      starredModelIds: vue.ref([]),
      skills: vue.ref([]),
      skillsLoaded: vue.ref(true),
      chatGateVerdict: vue.ref('ok'),
      experimentalFlags: vue.ref({}),
      promptPrediction: vue.ref(null),
      acceptPromptPrediction: vi.fn(() => null),
      handlePromptPredictionInput: vi.fn(),
      handlePromptPredictionSubmit: vi.fn(),
      notify: vi.fn(),
      toggleGoalMode: vi.fn(),
      togglePlanMode: vi.fn(),
      toggleSwarmMode: vi.fn(),
      toggleTowerMode: vi.fn(),
      setThinking: vi.fn(),
      setPermission: vi.fn(),
      selectModel: vi.fn(),
    }),
  };
});

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { createComposerSnapshot, textToDoc } from '@moonshot-ai/app-composer/model';
import Composer from '../src/composer/Composer.vue';

let app: App | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  });
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ font: '', measureText: (text: string) => ({ width: text.length * 8 }) }),
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

describe('Composer project trust overlay', () => {
  it('covers the card with a centered spinner pill, freezes the toolbar but keeps the editor editable, and recovers when cleared', async () => {
    const reason = ref<string | undefined>('正在检查信任状态…');
    const tooltip = ref<string | undefined>('正在确认项目信任状态，完成后即可发送');
    const submits: unknown[] = [];
    let composer!: InstanceType<typeof Composer>;
    app = createApp({
      render: () => h(Composer, {
        ref: (value) => { composer = value as InstanceType<typeof Composer>; },
        sessionSubmitBlockedReason: reason.value,
        sessionSubmitBlockedTooltip: tooltip.value,
        onSubmit: (payload: unknown) => submits.push(payload),
      }),
    });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await nextTick();

    const card = host.querySelector<HTMLElement>('.composer-card')!;
    const overlay = card.querySelector<HTMLElement>(':scope > .trust-overlay')!;
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute('role')).toBe('status');
    expect(overlay.getAttribute('aria-label')).toBe('正在确认项目信任状态，完成后即可发送');
    expect(overlay.querySelector('.trust-overlay-spinner.ui-spinner')).not.toBeNull();
    expect(overlay.querySelector('.trust-overlay-text')?.textContent).toBe('正在检查信任状态…');
    expect(host.querySelector('.toolbar-right .status-note')).toBeNull();

    const toolbar = card.querySelector<HTMLElement>('.toolbar')!;
    expect(toolbar.hasAttribute('inert')).toBe(true);
    expect(card.querySelector('.cin-wrap')?.hasAttribute('inert') ?? false).toBe(false);

    composer.loadForEdit('等待期间继续写的草稿', createComposerSnapshot(textToDoc('等待期间继续写的草稿'), [], []));
    await nextTick();
    const send = host.querySelector<HTMLButtonElement>('button.send')!;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('aria-label')).toBe('发送 ↵');

    const input = host.querySelector('[aria-label="消息输入框"]')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(submits).toHaveLength(0);
    expect(input.textContent).toBe('等待期间继续写的草稿');

    reason.value = undefined;
    tooltip.value = undefined;
    await nextTick();
    expect(toolbar.hasAttribute('inert')).toBe(false);
    await vi.waitFor(() => {
      expect(host.querySelector('.trust-overlay')).toBeNull();
    }, { timeout: 500 });
    expect(send.disabled).toBe(false);
    expect(input.textContent).toBe('等待期间继续写的草稿');
  });
});
