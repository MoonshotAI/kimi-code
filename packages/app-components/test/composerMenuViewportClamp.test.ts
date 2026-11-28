// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModel } from '@moonshot-ai/app-core/api';
import type { ConversationStatus } from '@moonshot-ai/app-core/client/types';

const clientState = vi.hoisted(() => ({
  activeSessionId: null as null | { value: string | null },
  working: null as null | { value: boolean },
  status: null as null | { value: ConversationStatus | null },
  thinking: null as null | { value: string },
  models: null as null | { value: AppModel[] },
  recentModelIds: null as null | { value: string[] },
  selectModel: vi.fn(async (id: string) => {
    if (clientState.status!.value) clientState.status!.value = { ...clientState.status!.value, modelId: id, model: id };
  }),
  setSessionModel: vi.fn(),
  setThinking: vi.fn(),
}));

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const vue = await import('vue');
  clientState.activeSessionId = vue.ref<string | null>('sess-1');
  clientState.working = vue.ref(true);
  clientState.status = vue.ref<ConversationStatus | null>({
    connected: true,
    model: 'GPT-6.1 Sol',
    modelId: 'gpt-6.1-sol',
    permission: 'yolo',
    ctxUsed: 76200,
    ctxMax: 262144,
  });
  clientState.thinking = vue.ref('max');
  clientState.recentModelIds = vue.ref<string[]>([]);
  clientState.models = vue.ref<AppModel[]>([
    {
      id: 'gpt-6-astra',
      provider: 'openai',
      model: 'gpt-6-astra',
      displayName: 'GPT-6 Astra',
      maxContextSize: 262144,
      capabilities: ['thinking'],
      supportEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    },
    {
      id: 'gpt-6.1-sol',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      displayName: 'GPT-6.1 Sol',
      maxContextSize: 262144,
      capabilities: ['thinking'],
      supportEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'max',
    },
  ]);
  return {
    ...actual,
    useKimiWebClient: () => ({
      activeSessionId: clientState.activeSessionId!,
      activeWorkspaceId: vue.ref('ws-1'),
      activity: vue.ref('running'),
      working: clientState.working!,
      isStartingFirstPrompt: vue.ref(false),
      queued: vue.ref([]),
      searchFiles: vi.fn(async () => []),
      uploadImage: vi.fn(),
      status: clientState.status!,
      thinking: clientState.thinking!,
      planMode: vue.ref(false),
      planArmed: vue.ref(false),
      swarmMode: vue.ref(false),
      towerMode: vue.ref(false),
      goalMode: vue.ref(false),
      goal: vue.ref(null),
      activationBadges: vue.ref([]),
      models: clientState.models!,
      config: vue.ref(null),
      recentModelIds: clientState.recentModelIds!,
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
      setThinking: clientState.setThinking,
      setPermission: vi.fn(),
      selectModel: clientState.selectModel,
      setSessionModel: clientState.setSessionModel,
    }),
    getKimiWebApi: () => ({
      getSessionContextSummary: vi.fn(async () => ({
        session_id: 'sess-1',
        agent_id: 'main',
        captured_at: 0,
        tokens: { used: 76200, max: 262144 },
        groups: [{ role: 'user', count: 1, tokens: 76200 }],
      })),
    }),
  };
});

import { createKimiI18n } from '@moonshot-ai/app-i18n';

let app: App | undefined;
let host: HTMLDivElement;
let storage: Map<string, string>;
let isMobileViewport = true;
let menuDimensions = { modelWidth: 360, modelHeight: 305, permWidth: 390, permHeight: 180, ctxWidth: 268, ctxHeight: 210 };

const origOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

function mockRect(el: Element, rect: Partial<DOMRect>): void {
  const left = rect.left ?? 0;
  const top = rect.top ?? 0;
  const width = rect.width ?? Math.max(0, (rect.right ?? 0) - left);
  const height = rect.height ?? Math.max(0, (rect.bottom ?? 0) - top);
  const right = rect.right ?? left + width;
  const bottom = rect.bottom ?? top + height;
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: left,
      y: top,
      left,
      top,
      right,
      bottom,
      width,
      height,
      toJSON: () => ({}),
    }),
  });
}

beforeAll(async () => {
  await import('../src/composer/Composer.vue');
});

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  isMobileViewport = true;
  clientState.recentModelIds!.value = [];
  menuDimensions = { modelWidth: 360, modelHeight: 305, permWidth: 390, permHeight: 180, ctxWidth: 268, ctxHeight: 210 };
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      let natural: number | null = null;
      if (this.classList.contains('model-dropdown')) natural = menuDimensions.modelWidth;
      else if (this.classList.contains('perm-dropdown')) natural = menuDimensions.permWidth;
      else if (this.classList.contains('ctx-card')) natural = menuDimensions.ctxWidth;
      if (natural !== null) {
        const cap = Number.parseFloat(this.style.maxWidth);
        return Number.isFinite(cap) ? Math.min(natural, cap) : natural;
      }
      return origOffsetWidth?.get ? origOffsetWidth.get.call(this) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('model-dropdown')) return menuDimensions.modelHeight;
      if (this.classList.contains('perm-dropdown')) return menuDimensions.permHeight;
      if (this.classList.contains('ctx-card')) return menuDimensions.ctxHeight;
      return origOffsetHeight?.get ? origOffsetHeight.get.call(this) : 0;
    },
  });
  storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
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
    matches: query.includes('max-width') ? isMobileViewport : false,
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
  document.querySelectorAll('body > .sheet-root').forEach((el) => el.remove());
  if (origOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', origOffsetWidth);
  if (origOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', origOffsetHeight);
  Reflect.deleteProperty(window, 'visualViewport');
  vi.unstubAllGlobals();
  vi.resetModules();
});

let composerInstance: { openModelMenu?: (targetSid?: string) => void } | undefined;

async function mountComposer(viewportWidth: number, viewportHeight: number): Promise<void> {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewportHeight });
  const { default: Composer } = await import('../src/composer/Composer.vue');
  composerInstance = undefined;
  app = createApp({
    render: () => h(Composer, { ref: (el) => { composerInstance = el as typeof composerInstance; } }),
  });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.mount(host);
  await nextTick();
}

async function setContextInspectorEnabled(enabled: boolean): Promise<void> {
  const { useContextInspector } = await import('@moonshot-ai/app-core/composables');
  useContextInspector().setContextInspectorEnabled(enabled);
}

describe('Composer context ring', () => {
  it('stays a static usage indicator while the context inspector is off', async () => {
    isMobileViewport = false;
    await setContextInspectorEnabled(false);
    await mountComposer(1200, 820);

    const ring = host.querySelector<HTMLElement>('.ctx-group')!;
    expect(ring.tagName).toBe('SPAN');
    expect(ring.getAttribute('role')).toBe('img');
    expect(ring.getAttribute('aria-label')).toMatch(/^使用 .+ tokens \(30%\)$/);

    ring.click();
    await nextTick();
    expect(host.querySelector('.ctx-card')).toBeNull();
  });

  it('closes the card with Escape while focus stays on the ring', async () => {
    isMobileViewport = false;
    await setContextInspectorEnabled(true);
    await mountComposer(1200, 820);

    const ring = host.querySelector<HTMLButtonElement>('.ctx-group')!;
    ring.click();
    await nextTick();
    expect(ring.getAttribute('aria-expanded')).toBe('true');

    ring.focus();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    ring.dispatchEvent(escape);
    await nextTick();
    expect(escape.defaultPrevented).toBe(true);
    expect(ring.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(ring);
  });
});

describe('Composer recent model menu', () => {
  beforeEach(() => {
    isMobileViewport = false;
    clientState.activeSessionId!.value = 'sess-1';
    clientState.thinking!.value = 'max';
    clientState.status!.value = {
      connected: true,
      model: 'GPT-6.1 Sol',
      modelId: 'gpt-6.1-sol',
      permission: 'yolo',
      ctxUsed: 76200,
      ctxMax: 262144,
    };
    clientState.selectModel.mockClear();
    clientState.setSessionModel.mockClear();
    clientState.setThinking.mockClear();
  });

  it('stages model and effort clicks without applying them, freezes row order, and commits on outside click', async () => {
    await mountComposer(1200, 820);

    const modelPill = host.querySelector<HTMLButtonElement>('.model-pill')!;
    modelPill.click();
    await nextTick();
    await nextTick();

    const labels = [...host.querySelectorAll<HTMLElement>('.mqm-body > .mqm-label')].map(
      (section) => section.textContent?.trim(),
    );
    const rows = [...host.querySelectorAll<HTMLElement>('.mqm-recent-scroll .mqm-row, .mqm-provider-scroll .mqm-row')];
    const names = rows.map((row) => row.querySelector('.mqm-name')?.textContent?.trim());

    expect(labels).toEqual(['最近使用', 'openai']);
    expect(names).toEqual(['GPT-6.1 Sol', 'GPT-6.1 Sol', 'GPT-6 Astra']);
    expect(rows[0]?.querySelector('.mqm-provider')?.textContent?.trim()).toBe('openai');
    expect(rows.filter((row) => row.getAttribute('aria-checked') === 'true')).toHaveLength(2);

    rows[2]?.click();
    await nextTick();
    expect(clientState.selectModel).not.toHaveBeenCalled();
    expect(clientState.setThinking).not.toHaveBeenCalled();
    expect(clientState.status!.value?.modelId).toBe('gpt-6.1-sol');

    const reorderedRows = [...host.querySelectorAll<HTMLElement>('.mqm-recent-scroll .mqm-row, .mqm-provider-scroll .mqm-row')];
    expect(
      reorderedRows.map((row) => row.querySelector('.mqm-name')?.textContent?.trim()),
    ).toEqual(['GPT-6.1 Sol', 'GPT-6.1 Sol', 'GPT-6 Astra']);
    expect(reorderedRows[2]?.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('.model-dropdown')).not.toBeNull();

    host.querySelector<HTMLElement>('[data-row-key="action:effort"]')!.click();
    await nextTick();
    const lowOption = [...host.querySelectorAll<HTMLElement>('.mqm-flyout .mqm-row')].find(
      (row) => row.textContent?.trim() === 'Low',
    )!;
    lowOption.click();
    await nextTick();
    expect(clientState.selectModel).not.toHaveBeenCalled();
    expect(clientState.setThinking).not.toHaveBeenCalled();
    expect(host.querySelector('[data-row-key="action:effort"] .mqm-action-value')?.textContent?.trim()).toBe('Low');

    document.body.click();
    await nextTick();
    await vi.waitFor(() => expect(clientState.selectModel).toHaveBeenCalledWith('gpt-6-astra'));
    expect(clientState.setThinking).toHaveBeenCalledWith('low');
    expect(host.querySelector('.model-dropdown')?.classList.contains('ui-menu-pop-leave-active')).toBe(true);
  });

  it('discards staged changes when dismissed with Escape', async () => {
    await mountComposer(1200, 820);

    host.querySelector<HTMLButtonElement>('.model-pill')!.click();
    await nextTick();
    await nextTick();

    const rows = [...host.querySelectorAll<HTMLElement>('.mqm-recent-scroll .mqm-row, .mqm-provider-scroll .mqm-row')];
    rows[2]?.click();
    await nextTick();
    expect(rows[2]?.getAttribute('aria-checked')).toBe('true');

    host.querySelector<HTMLElement>('.mqm')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();

    expect(host.querySelector('.model-dropdown')?.classList.contains('ui-menu-pop-leave-active')).toBe(true);
    expect(clientState.selectModel).not.toHaveBeenCalled();
    expect(clientState.setThinking).not.toHaveBeenCalled();
    expect(clientState.status!.value?.modelId).toBe('gpt-6.1-sol');
  });

  it('does not apply staged changes after switching to another session', async () => {
    await mountComposer(1200, 820);

    host.querySelector<HTMLButtonElement>('.model-pill')!.click();
    await nextTick();
    await nextTick();

    host.querySelectorAll<HTMLElement>('.mqm-recent-scroll .mqm-row, .mqm-provider-scroll .mqm-row')[2]?.click();
    await nextTick();

    clientState.activeSessionId!.value = 'sess-2';
    await nextTick();
    await nextTick();

    expect(host.querySelector('.model-dropdown')?.classList.contains('ui-menu-pop-leave-active')).toBe(true);
    expect(clientState.selectModel).not.toHaveBeenCalled();
    expect(clientState.setThinking).not.toHaveBeenCalled();
  });

  it('previews the picked model default effort on a new-session page and applies a chosen effort equal to the current one', async () => {
    clientState.activeSessionId!.value = '';
    await mountComposer(1200, 820);

    host.querySelector<HTMLButtonElement>('.model-pill')!.click();
    await nextTick();
    await nextTick();

    const astra = [...host.querySelectorAll<HTMLElement>('.mqm > .mqm-scroll > .mqm-section .mqm-row')].findLast(
      (row) => row.querySelector('.mqm-name')?.textContent?.trim() === 'GPT-6 Astra',
    )!;
    astra.click();
    await nextTick();
    expect(host.querySelector('[data-row-key="action:effort"] .mqm-action-value')?.textContent?.trim()).toBe('High');

    host.querySelector<HTMLElement>('[data-row-key="action:effort"]')!.click();
    await nextTick();
    [...host.querySelectorAll<HTMLElement>('.mqm-flyout .mqm-row')].find((row) => row.textContent?.trim() === 'Max')!.click();
    await nextTick();

    document.body.click();
    await nextTick();
    await vi.waitFor(() => expect(clientState.selectModel).toHaveBeenCalledWith('gpt-6-astra'));
    expect(clientState.setThinking).toHaveBeenCalledWith('max');
  });

  it('previews the picked model default effort when the session model has no thinking support', async () => {
    const catalog = clientState.models!.value;
    clientState.models!.value = [
      ...catalog,
      { id: 'plain-model', provider: 'openai', model: 'plain-model', displayName: 'Plain Model', maxContextSize: 128000, capabilities: [] },
    ];
    clientState.status!.value = { ...clientState.status!.value!, model: 'Plain Model', modelId: 'plain-model' };
    clientState.thinking!.value = 'off';
    try {
      await mountComposer(1200, 820);

      host.querySelector<HTMLButtonElement>('.model-pill')!.click();
      await nextTick();
      await nextTick();

      const astra = [...host.querySelectorAll<HTMLElement>('.mqm > .mqm-scroll > .mqm-section .mqm-row')].findLast(
        (row) => row.querySelector('.mqm-name')?.textContent?.trim() === 'GPT-6 Astra',
      )!;
      astra.click();
      await nextTick();
      expect(host.querySelector('[data-row-key="action:effort"] .mqm-action-value')?.textContent?.trim()).toBe('High');

      document.body.click();
      await nextTick();
      await vi.waitFor(() => expect(clientState.selectModel).toHaveBeenCalledWith('gpt-6-astra'));
      expect(clientState.setThinking).not.toHaveBeenCalled();
    } finally {
      clientState.models!.value = catalog;
    }
  });

  it('repairs a background session model on blur without switching the active session or choosing its thinking level', async () => {
    await mountComposer(1200, 820);
    const { sessionsStore } = await import('@moonshot-ai/app-client/stores');
    sessionsStore().sessions = [
      { id: 'sess-1', model: 'gpt-6.1-sol', cwd: '/project' },
      { id: 'sess-bg', model: 'missing/model', cwd: '/project' },
    ] as ReturnType<typeof sessionsStore>['sessions'];

    composerInstance?.openModelMenu?.('sess-bg');
    await nextTick();
    await nextTick();

    expect(clientState.activeSessionId!.value).toBe('sess-1');
    const providerRows = [...host.querySelectorAll<HTMLElement>('.mqm-provider-scroll .mqm-row')];
    providerRows[0]!.click();
    await nextTick();
    expect(clientState.setSessionModel).not.toHaveBeenCalled();
    expect(clientState.selectModel).not.toHaveBeenCalled();

    document.body.click();
    await nextTick();
    expect(clientState.activeSessionId!.value).toBe('sess-1');
    expect(clientState.selectModel).not.toHaveBeenCalled();
    expect(clientState.setSessionModel).toHaveBeenCalledWith('sess-bg', 'gpt-6-astra', undefined);
  });
});

describe('Composer toolbar popup viewport clamping', () => {
  beforeEach(() => {
    clientState.activeSessionId!.value = 'sess-1';
    clientState.thinking!.value = 'max';
    clientState.status!.value = {
      connected: true,
      model: 'GPT-6.1 Sol',
      modelId: 'gpt-6.1-sol',
      permission: 'yolo',
      ctxUsed: 76200,
      ctxMax: 262144,
    };
    clientState.selectModel.mockClear();
    clientState.setSessionModel.mockClear();
    clientState.setThinking.mockClear();
  });

  it('opens the model bottom sheet with top search on mobile viewports instead of the anchored dropdown', async () => {
    isMobileViewport = true;
    await mountComposer(360, 740);

    const modelPill = host.querySelector<HTMLElement>('.model-pill')!;
    expect(modelPill.getAttribute('aria-haspopup')).toBe('dialog');
    modelPill.click();
    await nextTick();
    await nextTick();

    expect(host.querySelector('.model-dropdown')).toBeNull();
    expect(document.querySelector('body > .sheet-root')).not.toBeNull();
    expect(document.querySelector('.sheet-root .sheet-title')?.textContent).toBe('切换模型');
    const searchWrap = document.querySelector('.mqs-search-wrap');
    const list = document.querySelector('.mqs-list');
    expect(searchWrap?.compareDocumentPosition(list!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps the model dropdown aligned to the model pill right edge and capped at 480px on wide viewports', async () => {
    isMobileViewport = false;
    await mountComposer(1200, 820);

    const toolbar = host.querySelector<HTMLElement>('.toolbar')!;
    const modelPill = host.querySelector<HTMLElement>('.model-pill')!;
    expect(modelPill.getAttribute('aria-haspopup')).toBe('menu');
    mockRect(toolbar, { left: 368, right: 1094, width: 726, top: 761, bottom: 805, height: 44 });
    mockRect(modelPill, { left: 857, right: 1014, width: 157, top: 765, bottom: 797, height: 32 });

    modelPill.click();
    await nextTick();
    await nextTick();
    await nextTick();

    const menu = host.querySelector<HTMLElement>('.model-dropdown')!;
    expect(menu.style.right).toBe('80px');
    expect(menu.style.maxHeight).toBe('480px');
  });

  it('clamps the permission dropdown inside a narrow mobile toolbar, flips downward when needed, and closes on resize', async () => {
    isMobileViewport = true;
    menuDimensions = { modelWidth: 360, modelHeight: 305, permWidth: 390, permHeight: 180, ctxWidth: 268, ctxHeight: 210 };
    await mountComposer(360, 740);

    const toolbar = host.querySelector<HTMLElement>('.toolbar')!;
    const permPill = host.querySelector<HTMLElement>('.perm-pill')!;
    mockRect(toolbar, { left: 13, right: 347, width: 334, top: 40, bottom: 96, height: 56 });
    mockRect(permPill, { left: 61, right: 105, width: 44, top: 44, bottom: 88, height: 44 });

    permPill.click();
    await nextTick();
    await nextTick();
    await nextTick();

    const menu = host.querySelector<HTMLElement>('.perm-dropdown')!;
    expect(menu.style.maxWidth).toBe('334px');
    expect(menu.style.left).toBe('0px');
    expect(menu.classList.contains('flip-down')).toBe(true);
    expect(menu.style.maxHeight).toBe('632px');

    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(permPill.classList.contains('open')).toBe(false);
    expect(menu.classList.contains('ui-menu-pop-leave-active')).toBe(true);
  });

  it('keeps the mobile model sheet open when the software keyboard resizes visualViewport and commits on scrim tap', async () => {
    isMobileViewport = true;
    clientState.selectModel.mockClear();
    clientState.setThinking.mockClear();
    let onVisualResize: (() => void) | undefined;
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        offsetLeft: 0,
        offsetTop: 0,
        width: 360,
        height: 740,
        addEventListener: (type: string, fn: () => void) => { if (type === 'resize') onVisualResize = fn; },
        removeEventListener: vi.fn(),
      },
    });
    await mountComposer(360, 740);

    host.querySelector<HTMLElement>('.model-pill')!.click();
    await nextTick();
    await nextTick();

    document.querySelector<HTMLElement>('[data-row-key="provider:gpt-6-astra"]')!.click();
    await nextTick();
    expect(clientState.selectModel).not.toHaveBeenCalled();

    onVisualResize?.();
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(document.querySelector('.sheet-root')).not.toBeNull();
    expect(clientState.selectModel).not.toHaveBeenCalled();

    document.querySelector<HTMLElement>('.sheet-scrim')!.click();
    await nextTick();
    await vi.waitFor(() => expect(clientState.selectModel).toHaveBeenCalledWith('gpt-6-astra'));
  });

  it('discards staged mobile sheet selections on Escape while focus remains on the model pill', async () => {
    isMobileViewport = true;
    await mountComposer(390, 844);

    const pill = host.querySelector<HTMLButtonElement>('.model-pill')!;
    pill.click();
    await nextTick();
    await nextTick();

    document.querySelector<HTMLElement>('[data-row-key="provider:gpt-6-astra"]')!.click();
    await nextTick();
    pill.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();

    expect(clientState.selectModel).not.toHaveBeenCalled();
    expect(clientState.setThinking).not.toHaveBeenCalled();
    expect(pill.getAttribute('aria-expanded')).toBe('false');
  });

  it('commits staged mobile sheet selections when the viewport widens past the mobile breakpoint', async () => {
    isMobileViewport = true;
    clientState.selectModel.mockClear();
    const mediaListeners: ((event: { matches: boolean }) => void)[] = [];
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width') ? isMobileViewport : false,
      media: query,
      addEventListener: (type: string, fn: (event: { matches: boolean }) => void) => { if (type === 'change') mediaListeners.push(fn); },
      removeEventListener: vi.fn(),
    }));
    await mountComposer(390, 844);

    host.querySelector<HTMLElement>('.model-pill')!.click();
    await nextTick();
    await nextTick();
    document.querySelector<HTMLElement>('[data-row-key="provider:gpt-6-astra"]')!.click();
    await nextTick();
    expect(clientState.selectModel).not.toHaveBeenCalled();

    isMobileViewport = false;
    for (const fn of mediaListeners) fn({ matches: false });
    await nextTick();
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    await vi.waitFor(() => expect(clientState.selectModel).toHaveBeenCalledWith('gpt-6-astra'));
  });

  it('centers the context ring card above the ring and clamps it within toolbar bounds', async () => {
    isMobileViewport = false;
    await setContextInspectorEnabled(true);
    await mountComposer(1200, 820);

    const toolbar = host.querySelector<HTMLElement>('.toolbar')!;
    const ctxBtn = host.querySelector<HTMLElement>('.ctx-group')!;
    mockRect(toolbar, { left: 368, right: 1094, width: 726, top: 761, bottom: 805, height: 44 });
    mockRect(ctxBtn, { left: 820, right: 852, width: 32, top: 765, bottom: 797, height: 32 });

    ctxBtn.click();
    await nextTick();
    await nextTick();
    await nextTick();

    let card = host.querySelector<HTMLElement>('.ctx-card')!;
    expect(card.style.left).toBe('334px');
    expect(card.style.right).toBe('auto');

    ctxBtn.click();
    await nextTick();

    mockRect(ctxBtn, { left: 1054, right: 1086, width: 32, top: 765, bottom: 797, height: 32 });
    ctxBtn.click();
    await nextTick();
    await nextTick();
    await nextTick();

    card = host.querySelector<HTMLElement>('.ctx-card')!;
    expect(card.style.left).toBe('458px');
    expect(card.style.right).toBe('auto');
  });
});
