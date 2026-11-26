// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModel } from '@moonshot-ai/app-core/api';
import type { QuickModelMenuAction, QuickModelMenuPayload } from '@moonshot-ai/app-core/quick-model-menu';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import ModelQuickSheet from '../src/composer/ModelQuickSheet.vue';

const kimiModels: AppModel[] = [
  { id: 'kimi/k2.5', provider: 'managed:kimi-code', model: 'k2.5', displayName: 'Kimi K2.5', maxContextSize: 262144, capabilities: ['thinking', 'tool_use', 'image_in'], supportEfforts: ['low', 'high'], defaultEffort: 'high' },
  { id: 'kimi/turbo', provider: 'managed:kimi-code', model: 'turbo', displayName: 'Kimi K2 Turbo', maxContextSize: 262144, capabilities: ['tool_use'] },
  { id: 'kimi/long', provider: 'managed:kimi-code', model: 'long', displayName: 'Kimi Very Long Model Name For Truncation Check', maxContextSize: 262144, capabilities: ['tool_use', 'image_in'] },
];

const otherModels: AppModel[] = [
  { id: 'openrouter/sonnet', provider: 'openrouter', model: 'sonnet', displayName: 'Claude Sonnet 4.5', maxContextSize: 200 * 1024, capabilities: ['thinking', 'tool_use', 'image_in'], supportEfforts: ['low', 'medium', 'high'] },
  { id: 'openrouter/gpt', provider: 'openrouter', model: 'gpt', displayName: 'GPT-5.1', maxContextSize: 400 * 1024, capabilities: ['thinking', 'tool_use'], supportEfforts: ['low', 'high'] },
  { id: 'openrouter/haiku', provider: 'openrouter', model: 'haiku', displayName: 'Claude 3.5 Haiku', maxContextSize: 200 * 1024, capabilities: ['tool_use'] },
];

let app: App | undefined;
let host: HTMLDivElement;
let actions: QuickModelMenuAction[];
let dismissed = 0;
let state: ReturnType<typeof reactive<{ open: boolean; payload: QuickModelMenuPayload }>>;

function initialState(overrides: Partial<QuickModelMenuPayload> = {}): QuickModelMenuPayload {
  return {
    models: [...kimiModels, ...otherModels],
    recentModels: [kimiModels[0]!, otherModels[0]!, otherModels[1]!, kimiModels[1]!, otherModels[2]!],
    providerModels: kimiModels,
    providers: [
      { id: 'managed:kimi-code', label: 'Kimi 订阅' },
      { id: 'openrouter', label: 'openrouter' },
    ],
    activeProvider: 'managed:kimi-code',
    activeProviderLabel: 'Kimi 订阅',
    currentModelId: 'kimi/k2.5',
    currentEffort: 'high',
    ...overrides,
  };
}

function mountSheet(overrides: Partial<QuickModelMenuPayload> = {}): void {
  state = reactive({ open: true, payload: initialState(overrides) });
  app = createApp({
    render: () =>
      h(ModelQuickSheet, {
        modelValue: state.open,
        payload: () => state.payload,
        'onUpdate:modelValue': (open: boolean) => { state.open = open; },
        onSelectModel: (modelId, effort, fromSearch) => actions.push({ type: 'select-model', modelId, ...(effort === undefined ? {} : { effort }), ...(fromSearch === true ? { fromSearch: true } : {}) }),
        onSelectEffort: (effort) => actions.push({ type: 'select-effort', effort }),
        onSelectProvider: (providerId) => actions.push({ type: 'select-provider', providerId }),
        onDismiss: () => { dismissed += 1; },
      }),
  });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
  app.mount(host);
}

function pointer(target: EventTarget, type: string, coords: { clientX?: number; clientY?: number } = {}): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...coords });
  Object.assign(event, { pointerId: 1, isPrimary: true, pointerType: 'touch' });
  target.dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  actions = [];
  dismissed = 0;
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  Reflect.deleteProperty(window, 'visualViewport');
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ModelQuickSheet main page', () => {
  it('renders title, top search, up to three recent rows with provider names, provider rows, and action rows', () => {
    mountSheet();
    expect(host.querySelector('.sheet-title')?.textContent).toBe('切换模型');
    expect(host.querySelector('.sheet-back')).toBeNull();
    expect(host.querySelector('.mqs-search-wrap .mqs-search-input')).not.toBeNull();
    expect(host.querySelector<HTMLElement>('.sheet-panel')!.style.maxHeight).toBe('calc(var(--app-height, 100dvh) * 0.9)');
    const labels = [...host.querySelectorAll('.mqs-label')].map((el) => el.textContent?.trim());
    expect(labels).toEqual(['最近使用', 'Kimi 订阅']);
    const recentRows = [...host.querySelectorAll<HTMLElement>('[data-row-key^="recent:"]')];
    expect(recentRows).toHaveLength(3);
    expect(recentRows[0]?.querySelector('.mqs-provider')?.textContent).toBe('Kimi 订阅');
    expect(recentRows[0]?.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('.mqs-recent-scroll [data-row-key^="recent:"]')).not.toBeNull();
    expect(host.querySelector('.mqs-provider-scroll [data-row-key^="recent:"]')).toBeNull();
    expect(host.querySelectorAll('.mqs-provider-scroll [data-row-key^="provider:"]')).toHaveLength(3);
    expect(host.querySelector('.mqs-fixed [data-row-key="action:provider"]')?.textContent).toContain('切换供应商');
    expect(host.querySelector('.mqs-fixed [data-row-key="action:effort"]')?.textContent).toContain('High');
  });

  it('keeps actions reachable in short landscape by scrolling the whole upper body, and hides actions while the keyboard is open', async () => {
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: media.includes('max-height'),
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    mountSheet();
    await nextTick();
    const body = host.querySelector<HTMLElement>('.mqs-body.is-fluid')!;
    expect(body).not.toBeNull();
    expect(body.querySelectorAll('[data-row-key^="recent:"]')).toHaveLength(3);
    expect(body.querySelectorAll('[data-row-key^="provider:"]')).toHaveLength(3);
    expect(host.querySelector('.mqs-fixed [data-row-key="action:provider"]')).not.toBeNull();

    host.querySelector<HTMLElement>('.mqs-search-input')!.dispatchEvent(new FocusEvent('focus'));
    await nextTick();
    expect(host.querySelector('[data-row-key="action:provider"]')).toBeNull();
    expect(host.querySelector('.mqs-body.is-fluid')).not.toBeNull();
  });

  it('stages model row clicks without closing the sheet', async () => {
    mountSheet();
    host.querySelector<HTMLElement>('[data-row-key="recent:openrouter/gpt"]')!.click();
    await nextTick();
    expect(actions).toEqual([{ type: 'select-model', modelId: 'openrouter/gpt' }]);
    expect(state.open).toBe(true);
  });

  it('disables the effort row when the current model does not support thinking', async () => {
    mountSheet({ currentModelId: 'kimi/turbo', currentEffort: undefined });
    const effortRow = host.querySelector<HTMLButtonElement>('[data-row-key="action:effort"]')!;
    expect(effortRow.textContent).toContain('不支持');
    expect(effortRow.disabled).toBe(true);
    effortRow.click();
    await nextTick();
    expect(host.querySelector('.sheet-back')).toBeNull();
  });
});

describe('ModelQuickSheet subpages', () => {
  it('pushes provider subpage, scrolls only the middle list to the active provider, and returns on selection', async () => {
    const providers = Array.from({ length: 12 }, (_, i) => ({ id: `p-${i + 1}`, label: `Provider ${i + 1}` }));
    mountSheet({ providers, activeProvider: 'p-10', activeProviderLabel: 'Provider 10' });
    const scrollTopSetter = vi.spyOn(Element.prototype, 'scrollTop', 'set');
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(44);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('mqs-scroll')) return { top: 100 } as DOMRect;
      if (this.dataset.providerId === 'p-10') return { top: 496 } as DOMRect;
      return { top: 0 } as DOMRect;
    });

    host.querySelector<HTMLElement>('[data-row-key="action:provider"]')!.click();
    await nextTick();
    await nextTick();
    expect(host.querySelector('.sheet-title')?.textContent).toBe('切换供应商');
    expect(host.querySelector('.sheet-back')).not.toBeNull();
    expect(host.querySelectorAll('[data-provider-id]')).toHaveLength(12);
    expect(scrollTopSetter).toHaveBeenCalledWith(218);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();

    host.querySelector<HTMLElement>('[data-provider-id="p-3"]')!.click();
    await nextTick();
    expect(actions).toEqual([{ type: 'select-provider', providerId: 'p-3' }]);
    expect(host.querySelector('.sheet-title')?.textContent).toBe('切换供应商');
    expect(host.querySelector('[data-provider-id="p-3"]')?.classList.contains('is-active')).toBe(true);

    host.querySelector<HTMLElement>('.sheet-back')!.click();
    await nextTick();
    expect(host.querySelector('.sheet-title')?.textContent).toBe('切换模型');
  });

  it('shows header divider once the middle list scrolls', async () => {
    mountSheet();
    host.querySelector<HTMLElement>('[data-row-key="action:provider"]')!.click();
    await nextTick();
    await nextTick();
    const head = host.querySelector('.sheet-head')!;
    expect(head.classList.contains('is-scrolled')).toBe(false);
    const scroller = host.querySelector<HTMLElement>('.mqs-scroll')!;
    let scrollTopValue = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTopValue,
      set: (value) => { scrollTopValue = value; },
    });
    scrollTopValue = 40;
    scroller.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(head.classList.contains('is-scrolled')).toBe(true);

    host.querySelector<HTMLElement>('.sheet-back')!.click();
    await nextTick();
    await nextTick();
    host.querySelector<HTMLElement>('[data-row-key="action:effort"]')!.click();
    await nextTick();
    await nextTick();
    expect(host.querySelector('.sheet-head')!.classList.contains('is-scrolled')).toBe(false);
  });

  it('pushes effort subpage with cloud description for the active effort and stages selection', async () => {
    mountSheet({ effortDescriptions: { low: '轻量思考，响应更快', high: '深入思考，适合复杂任务' } });
    host.querySelector<HTMLElement>('[data-row-key="action:effort"]')!.click();
    await nextTick();
    expect(host.querySelector('.sheet-title')?.textContent).toBe('思考强度');
    expect(host.querySelector('.mqs-desc')?.textContent).toBe('深入思考，适合复杂任务');
    host.querySelector<HTMLElement>('[data-effort="low"]')!.click();
    state.payload = { ...state.payload, currentEffort: 'low' };
    await nextTick();
    expect(actions).toEqual([{ type: 'select-effort', effort: 'low' }]);
    expect(host.querySelector('.sheet-title')?.textContent).toBe('思考强度');
    expect(host.querySelector('[data-effort="low"]')?.classList.contains('is-active')).toBe(true);
    expect(host.querySelector('[data-effort="low"] .mqs-check')).not.toBeNull();
    expect(host.querySelector('.mqs-desc')?.textContent).toBe('轻量思考，响应更快');

    host.querySelector<HTMLElement>('.sheet-back')!.click();
    await nextTick();
    expect(host.querySelector('.sheet-title')?.textContent).toBe('切换模型');
  });

  it('handles document-level Escape even when focus stays outside the sheet', async () => {
    mountSheet();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    host.querySelector<HTMLElement>('[data-row-key="action:provider"]')!.click();
    await nextTick();
    outside.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();
    expect(host.querySelector('.sheet-title')?.textContent).toBe('切换模型');
    expect(dismissed).toBe(0);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();
    expect(dismissed).toBe(1);
    expect(state.open).toBe(true);
    outside.remove();
  });

  it('supports arrow navigation, Enter to stage, ArrowLeft to go back, and type-to-search', async () => {
    mountSheet();
    const activeRowKey = () => host.querySelector<HTMLElement>('.mqs-row.is-active')?.dataset.rowKey;
    await vi.waitFor(() => expect(activeRowKey()).toBe('provider:kimi/k2.5'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(host.querySelector('.mqs-search-input'));
    (document.activeElement as HTMLElement).blur();
    await vi.waitFor(() => expect(activeRowKey()).toBe('provider:kimi/k2.5'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(activeRowKey()).toBe('recent:openrouter/gpt'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(activeRowKey()).toBe('provider:kimi/k2.5'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(activeRowKey()).toBe('provider:kimi/turbo'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await nextTick();
    expect(actions).toEqual([{ type: 'select-model', modelId: 'kimi/turbo' }]);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(activeRowKey()).toBe('provider:kimi/long'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(activeRowKey()).toBe('action:provider'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(activeRowKey()).toBe('action:effort'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.querySelector('.sheet-title')?.textContent).toBe('思考强度'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(host.querySelector('.sheet-title')?.textContent).toBe('切换模型'));
  });
});

describe('ModelQuickSheet search and detail', () => {
  it('filters results with accent highlights, clears via the clear button, and shows empty state', async () => {
    mountSheet();
    const input = host.querySelector<HTMLInputElement>('.mqs-search-input')!;
    input.value = 'claude';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    expect(host.querySelectorAll('[data-row-key^="search:"]')).toHaveLength(2);
    expect(host.querySelector('.mqs-match')?.textContent).toBe('Claude');

    input.value = 'gemini 3';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    expect(host.querySelector('.mqs-empty')?.textContent).toBe('没有匹配的模型');

    host.querySelector<HTMLElement>('.mqs-search-clear')!.click();
    await nextTick();
    expect(input.value).toBe('');
    expect(host.querySelector('[data-row-key^="recent:"]')).not.toBeNull();
  });

  it('pushes detail page for thinking search results and stages model with chosen effort', async () => {
    mountSheet();
    const input = host.querySelector<HTMLInputElement>('.mqs-search-input')!;
    input.value = 'sonnet';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    host.querySelector<HTMLElement>('[data-row-key="search:openrouter/sonnet"]')!.click();
    await nextTick();
    expect(actions).toEqual([]);
    expect(host.querySelector('.sheet-title')?.textContent).toBe('Claude Sonnet 4.5');
    expect(host.querySelector('.mqs-detail-subtitle')?.textContent).toBe('openrouter');
    expect(host.querySelectorAll('.mqs-cap')).toHaveLength(4);
    expect(host.querySelectorAll('[data-detail-effort] .mqs-check')).toHaveLength(0);

    host.querySelector<HTMLElement>('[data-detail-effort="medium"]')!.click();
    await nextTick();
    expect(actions).toEqual([{ type: 'select-model', modelId: 'openrouter/sonnet', effort: 'medium', fromSearch: true }]);
    expect(host.querySelector<HTMLInputElement>('.mqs-search-input')!.value).toBe('');
    expect(host.querySelector('.sheet-title')?.textContent).toBe('切换模型');
  });

  it('stages non-thinking search results directly and returns to the main list', async () => {
    mountSheet();
    const input = host.querySelector<HTMLInputElement>('.mqs-search-input')!;
    input.value = 'haiku';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    host.querySelector<HTMLElement>('[data-row-key="search:openrouter/haiku"]')!.click();
    await nextTick();
    expect(actions).toEqual([{ type: 'select-model', modelId: 'openrouter/haiku', fromSearch: true }]);
    expect(input.value).toBe('');
    expect(host.querySelector('.sheet-title')?.textContent).toBe('切换模型');
  });

  it('opens the detail page on long-press only when the row text is truncated', async () => {
    mountSheet();
    const truncated = host.querySelector<HTMLElement>('[data-row-key="provider:kimi/long"]')!;
    const normal = host.querySelector<HTMLElement>('[data-row-key="provider:kimi/turbo"]')!;
    const name = truncated.querySelector<HTMLElement>('.mqs-name')!;
    Object.defineProperty(name, 'scrollWidth', { configurable: true, value: 300 });
    Object.defineProperty(name, 'clientWidth', { configurable: true, value: 180 });

    pointer(normal, 'pointerdown', { clientX: 20, clientY: 20 });
    await vi.advanceTimersByTimeAsync(600);
    pointer(normal, 'pointerup');
    normal.click();
    await nextTick();
    expect(actions).toEqual([{ type: 'select-model', modelId: 'kimi/turbo' }]);
    expect(host.querySelector('.sheet-title')?.textContent).toBe('切换模型');

    pointer(truncated, 'pointerdown', { clientX: 20, clientY: 20 });
    await vi.advanceTimersByTimeAsync(501);
    await nextTick();
    expect(host.querySelector('.sheet-title')?.textContent).toBe('Kimi Very Long Model Name For Truncation Check');
    window.dispatchEvent(new MouseEvent('pointerup'));

    host.querySelector<HTMLElement>('.sheet-back')!.click();
    await nextTick();
    await nextTick();
    host.querySelector<HTMLElement>('[data-row-key="provider:kimi/long"]')!.click();
    await nextTick();
    expect(actions).toEqual([
      { type: 'select-model', modelId: 'kimi/turbo' },
      { type: 'select-model', modelId: 'kimi/long' },
    ]);
  });
});

describe('BottomSheet gestures, focus, and accessibility', () => {
  it('closes on scrim tap and on pull-down gesture past the threshold', async () => {
    mountSheet();
    host.querySelector<HTMLElement>('.sheet-scrim')!.click();
    await nextTick();
    expect(state.open).toBe(false);

    state.open = true;
    await nextTick();
    const grab = host.querySelector<HTMLElement>('.sheet-grab')!;
    pointer(grab, 'pointerdown', { clientX: 100, clientY: 700 });
    pointer(window, 'pointermove', { clientX: 100, clientY: 760 });
    pointer(window, 'pointerup', { clientX: 100, clientY: 830 });
    await nextTick();
    expect(state.open).toBe(false);
  });

  it('cancels an interrupted pull-down on pointercancel without closing or staging a model', async () => {
    mountSheet();
    const grab = host.querySelector<HTMLElement>('.sheet-grab')!;
    pointer(grab, 'pointerdown', { clientX: 100, clientY: 700 });
    pointer(window, 'pointermove', { clientX: 100, clientY: 840 });
    pointer(window, 'pointercancel', { clientX: 100, clientY: 840 });
    await nextTick();
    expect(state.open).toBe(true);
    expect(actions).toEqual([]);
  });

  it('does not fling-close when the user pauses before releasing below the distance threshold', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    mountSheet();
    const grab = host.querySelector<HTMLElement>('.sheet-grab')!;
    pointer(grab, 'pointerdown', { clientX: 100, clientY: 700 });
    now += 10;
    pointer(window, 'pointermove', { clientX: 100, clientY: 740 });
    now += 250;
    pointer(window, 'pointerup', { clientX: 100, clientY: 740 });
    await nextTick();
    expect(state.open).toBe(true);
  });

  it('closes from the grab button on Enter without activating the highlighted model row', async () => {
    mountSheet();
    await nextTick();
    await nextTick();
    const grab = host.querySelector<HTMLButtonElement>('.sheet-grab')!;
    expect(grab.tagName).toBe('BUTTON');
    grab.focus();
    grab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await nextTick();
    expect(actions).toEqual([]);

    grab.click();
    await nextTick();
    expect(state.open).toBe(false);
    expect(actions).toEqual([]);
  });

  it('moves focus into the dialog without opening search, traps Tab, and restores focus on close', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    mountSheet();
    await nextTick();
    await nextTick();

    const panel = host.querySelector<HTMLElement>('.sheet-panel')!;
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(panel);
    expect(panel.contains(document.activeElement)).toBe(true);

    const focusables = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);

    first.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);

    state.open = false;
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('gives every selectable radio row a labelled radiogroup owner', async () => {
    mountSheet();
    const radios = [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.length).toBeGreaterThan(0);
    expect(host.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
    for (const radio of radios) {
      const group = radio.closest('[role="radiogroup"]');
      expect(group).not.toBeNull();
      expect(group?.getAttribute('aria-label')).toBeTruthy();
    }

    host.querySelector<HTMLElement>('[data-row-key="action:provider"]')!.click();
    await nextTick();
    const subRadios = [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(subRadios).toHaveLength(2);
    for (const radio of subRadios) {
      expect(radio.closest('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('切换供应商');
    }
  });

  it('animates subpage height exactly once and ignores ResizeObserver callbacks during the transition', async () => {
    const observerCallbacks: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { observerCallbacks.push(cb); }
      observe(): void {}
      disconnect(): void {}
    });
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: () => [] });

    mountSheet();
    await nextTick();
    const panel = host.querySelector<HTMLElement>('.sheet-panel')!;
    Object.defineProperty(panel, 'offsetHeight', {
      configurable: true,
      get: () => (host.querySelector('.sheet-back') ? 260 : 574),
    });

    host.querySelector<HTMLElement>('[data-row-key="action:effort"]')!.click();
    await nextTick();
    await nextTick();

    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith(
      [{ height: '574px' }, { height: '260px' }],
      { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );

    for (const cb of observerCallbacks) cb();
    await nextTick();
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('pins the sheet above the software keyboard using visualViewport without closing', async () => {
    const listeners = new Map<string, () => void>();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        offsetTop: 0,
        height: 844,
        addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
        removeEventListener: (type: string) => listeners.delete(type),
      },
    });
    mountSheet();
    const vv = window.visualViewport as unknown as { height: number };
    vv.height = 460;
    listeners.get('resize')?.();
    await nextTick();
    const root = host.querySelector<HTMLElement>('.sheet-root')!;
    const panel = host.querySelector<HTMLElement>('.sheet-panel')!;
    expect(root.style.height).toBe('460px');
    expect(panel.style.maxHeight).toBe('460px');
    expect(state.open).toBe(true);
  });
});
