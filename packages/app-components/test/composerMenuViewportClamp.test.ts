// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModel } from '@moonshot-ai/app-core/api';
import type { ConversationStatus } from '@moonshot-ai/app-core/client/types';

const clientState = vi.hoisted(() => ({
  activeSessionId: null as null | { value: string | null },
  working: null as null | { value: boolean },
  status: null as null | { value: ConversationStatus | null },
  thinking: null as null | { value: string },
  models: null as null | { value: AppModel[] },
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
      starredModelIds: vue.ref([]),
      skills: vue.ref([]),
      skillsLoaded: vue.ref(true),
      chatGateVerdict: vue.ref('ok'),
      experimentalFlags: vue.ref({}),
      notify: vi.fn(),
      toggleGoalMode: vi.fn(),
      togglePlanMode: vi.fn(),
      toggleSwarmMode: vi.fn(),
      toggleTowerMode: vi.fn(),
      setThinking: vi.fn(),
      setPermission: vi.fn(),
      selectModel: vi.fn(),
    }),
    getKimiWebApi: () => ({
      getSessionContextSummary: vi.fn(async () => ({
        session_id: 'sess-1',
        agent_id: 'main',
        captured_at: 0,
        tokens: { used: 76200, max: 262144 },
        total_chars: 1200,
        groups: [{ role: 'user', count: 1, chars: 1200 }],
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

beforeEach(() => {
  isMobileViewport = true;
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
  if (origOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', origOffsetWidth);
  if (origOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', origOffsetHeight);
  Reflect.deleteProperty(window, 'visualViewport');
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mountComposer(viewportWidth: number, viewportHeight: number): Promise<void> {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewportHeight });
  const { default: Composer } = await import('../src/composer/Composer.vue');
  app = createApp({
    render: () => h(Composer),
  });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.mount(host);
  await nextTick();
}

async function setContextInspectorEnabled(enabled: boolean): Promise<void> {
  const { useContextInspector } = await import('@moonshot-ai/app-core');
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

describe('Composer toolbar popup viewport clamping', () => {
  it('clamps the model dropdown inside a narrow mobile toolbar instead of overflowing off the left edge', async () => {
    isMobileViewport = true;
    menuDimensions = { modelWidth: 360, modelHeight: 305, permWidth: 390, permHeight: 180, ctxWidth: 268, ctxHeight: 210 };
    await mountComposer(360, 740);

    const toolbar = host.querySelector<HTMLElement>('.toolbar')!;
    const modelPill = host.querySelector<HTMLElement>('.model-pill')!;
    mockRect(toolbar, { left: 13, right: 347, width: 334, top: 659, bottom: 715, height: 56 });
    mockRect(modelPill, { left: 223, right: 259, width: 36, top: 667, bottom: 703, height: 36 });

    modelPill.click();
    await nextTick();
    await nextTick();
    await nextTick();

    const menu = host.querySelector<HTMLElement>('.model-dropdown')!;
    expect(menu.style.maxWidth).toBe('334px');
    expect(menu.style.right).toBe('0px');
    expect(menu.classList.contains('flip-down')).toBe(false);
    expect(menu.style.maxHeight).toBe('647px');
  });

  it('keeps the model dropdown aligned to the model pill right edge on wide viewports', async () => {
    isMobileViewport = false;
    menuDimensions = { modelWidth: 392, modelHeight: 274, permWidth: 390, permHeight: 180, ctxWidth: 268, ctxHeight: 210 };
    await mountComposer(1200, 820);

    const toolbar = host.querySelector<HTMLElement>('.toolbar')!;
    const modelPill = host.querySelector<HTMLElement>('.model-pill')!;
    mockRect(toolbar, { left: 368, right: 1094, width: 726, top: 761, bottom: 805, height: 44 });
    mockRect(modelPill, { left: 857, right: 1014, width: 157, top: 765, bottom: 797, height: 32 });

    modelPill.click();
    await nextTick();
    await nextTick();
    await nextTick();

    const menu = host.querySelector<HTMLElement>('.model-dropdown')!;
    expect(menu.style.maxWidth).toBe('726px');
    expect(menu.style.right).toBe('80px');
    expect(menu.classList.contains('flip-down')).toBe(false);
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
    expect(menu.classList.contains('composer-menu-pop-leave-active')).toBe(true);
  });

  it('respects narrowed visualViewport bounds when clamping horizontally', async () => {
    isMobileViewport = true;
    menuDimensions = { modelWidth: 320, modelHeight: 260, permWidth: 390, permHeight: 180, ctxWidth: 268, ctxHeight: 210 };
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        offsetLeft: 40,
        offsetTop: 0,
        width: 260,
        height: 700,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    await mountComposer(360, 740);

    const toolbar = host.querySelector<HTMLElement>('.toolbar')!;
    const modelPill = host.querySelector<HTMLElement>('.model-pill')!;
    mockRect(toolbar, { left: 13, right: 347, width: 334, top: 620, bottom: 676, height: 56 });
    mockRect(modelPill, { left: 223, right: 259, width: 36, top: 628, bottom: 664, height: 36 });

    modelPill.click();
    await nextTick();
    await nextTick();
    await nextTick();

    const menu = host.querySelector<HTMLElement>('.model-dropdown')!;
    expect(menu.style.maxWidth).toBe('244px');
    expect(menu.style.right).toBe('55px');
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
