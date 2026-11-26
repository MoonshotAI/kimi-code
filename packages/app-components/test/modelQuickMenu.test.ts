// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModel } from '@moonshot-ai/app-core/api';
import type { QuickModelMenuAction, QuickModelMenuPayload } from '@moonshot-ai/app-core/quick-model-menu';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import ModelQuickMenu from '../src/composer/ModelQuickMenu.vue';

const kimiModels: AppModel[] = [
  { id: 'kimi/k2.5', provider: 'managed:kimi-code', model: 'k2.5', displayName: 'Kimi K2.5', maxContextSize: 262144, capabilities: ['thinking', 'tool_use', 'image_in'], supportEfforts: ['low', 'high'], defaultEffort: 'high' },
  { id: 'kimi/turbo', provider: 'managed:kimi-code', model: 'turbo', displayName: 'Kimi K2 Turbo', maxContextSize: 262144, capabilities: ['tool_use'] },
  { id: 'kimi/thinking', provider: 'managed:kimi-code', model: 'thinking', displayName: 'Kimi K2 Thinking', maxContextSize: 262144, capabilities: ['always_thinking', 'tool_use'] },
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

function initialState(overrides: Partial<QuickModelMenuPayload> = {}): QuickModelMenuPayload {
  return {
    models: [...kimiModels, ...otherModels],
    recentModels: [kimiModels[0]!, otherModels[0]!, otherModels[1]!],
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

function mountMenu(state: QuickModelMenuPayload, maxHeight = 480): void {
  const props = reactive({ state, maxHeight });
  app = createApp({
    render: () =>
      h(ModelQuickMenu, {
        models: props.state.models,
        recentModels: props.state.recentModels,
        providerModels: props.state.providerModels,
        providers: props.state.providers,
        activeProvider: props.state.activeProvider,
        activeProviderLabel: props.state.activeProviderLabel,
        currentModelId: props.state.currentModelId,
        currentEffort: props.state.currentEffort,
        effortDescriptions: props.state.effortDescriptions,
        maxHeight: props.maxHeight,
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

function rows(selector = '.mqm .mqm-scroll .mqm-row, .mqm > .mqm-actions .mqm-row'): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(selector)];
}

beforeEach(() => {
  vi.useFakeTimers();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  actions = [];
  dismissed = 0;
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ModelQuickMenu states', () => {
  it('renders recent models with provider names and additively repeats the current provider group', () => {
    mountMenu(initialState());
    const labels = [...host.querySelectorAll('.mqm-body > .mqm-label')].map((el) => el.textContent?.trim());
    expect(labels).toEqual(['最近使用', 'Kimi 订阅']);
    const recentRows = rows('.mqm-recent-scroll .mqm-row');
    expect(recentRows).toHaveLength(3);
    expect(recentRows[0]?.querySelector('.mqm-name')?.textContent).toBe('Kimi K2.5');
    expect(recentRows[0]?.querySelector('.mqm-provider')?.textContent).toBe('Kimi 订阅');
    expect(recentRows[1]?.querySelector('.mqm-provider')?.textContent).toBe('openrouter');
    expect(host.querySelectorAll('[data-row-key="provider:kimi/k2.5"] svg')).toHaveLength(1);
  });

  it('hides the recent section entirely when empty', () => {
    mountMenu(initialState({ recentModels: [] }));
    expect(host.textContent).not.toContain('最近使用');
    expect(host.querySelector('.mqm-body > .mqm-label')?.textContent?.trim()).toBe('Kimi 订阅');
  });

  it('shows a 500ms hover capability card on model rows', async () => {
    mountMenu(initialState());
    const row = host.querySelector<HTMLElement>('[data-row-key="recent:openrouter/sonnet"]')!;
    row.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.advanceTimersByTimeAsync(499);
    expect(host.querySelector('.mqm-hover-card')).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    await nextTick();
    const card = host.querySelector('.mqm-hover-card');
    expect(card?.textContent).toContain('Claude Sonnet 4.5');
    expect(card?.textContent).toContain('200K 上下文');
    expect(card?.textContent).toContain('图片理解');
    expect(card?.textContent).toContain('工具调用');
    expect(card?.textContent).toContain('思考');
  });

  it('opens the provider submenu, emits selectProvider without switching models, and caps provider scroll height', async () => {
    mountMenu(initialState());
    host.querySelector<HTMLElement>('[data-row-key="action:provider"]')!.click();
    await nextTick();
    const flyout = host.querySelector('.mqm-flyout')!;
    expect(flyout.textContent).toContain('供应商');
    const options = [...flyout.querySelectorAll<HTMLElement>('.mqm-row')];
    expect(options.map((el) => el.textContent?.trim())).toEqual(['Kimi 订阅', 'openrouter']);
    options[1]!.click();
    await nextTick();
    expect(actions).toEqual([{ type: 'select-provider', providerId: 'openrouter' }]);
    expect(host.querySelector('.mqm-flyout')).toBeNull();
  });

  it('disables the thinking submenu when the current model does not support thinking', async () => {
    mountMenu(initialState({ currentModelId: 'kimi/turbo' }));
    const effortRow = host.querySelector<HTMLElement>('[data-row-key="action:effort"]')!;
    expect(effortRow.textContent).toContain('不支持');
    expect(effortRow.getAttribute('aria-disabled')).toBe('true');
    effortRow.click();
    await nextTick();
    expect(host.querySelector('.mqm-flyout')).toBeNull();
  });

  it('opens the thinking submenu with description and emits selectEffort on choice', async () => {
    mountMenu(initialState());
    host.querySelector<HTMLElement>('[data-row-key="action:effort"]')!.click();
    await nextTick();
    const flyout = host.querySelector('.mqm-flyout')!;
    expect(flyout.textContent).toContain('强度越高，思考越深入');
    const options = [...flyout.querySelectorAll<HTMLElement>('.mqm-row')];
    expect(options.map((el) => el.textContent?.trim())).toEqual(['Off', 'Low', 'High']);
    options[1]!.click();
    expect(actions).toEqual([{ type: 'select-effort', effort: 'low' }]);
  });

  it('highlights the active effort on open, previews cloud descriptions per highlighted effort, and falls back when unconfigured', async () => {
    mountMenu(initialState({
      effortDescriptions: { low: '轻量思考，响应更快', high: '深入思考，适合复杂任务' },
    }));
    const root = host.querySelector<HTMLElement>('.mqm')!;
    host.querySelector<HTMLElement>('[data-row-key="action:effort"]')!.click();
    await nextTick();

    const desc = () => host.querySelector('.mqm-thinking-desc')?.textContent?.trim();
    expect(host.querySelector('.mqm-flyout .mqm-row.is-active')?.textContent?.trim()).toBe('High');
    expect(desc()).toBe('深入思考，适合复杂任务');

    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    await nextTick();
    expect(host.querySelector('.mqm-flyout .mqm-row.is-active')?.textContent?.trim()).toBe('Low');
    expect(desc()).toBe('轻量思考，响应更快');

    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    await nextTick();
    expect(host.querySelector('.mqm-flyout .mqm-row.is-active')?.textContent?.trim()).toBe('Off');
    expect(desc()).toBe('强度越高，思考越深入，但耗时更长、Token 消耗更多');
  });

  it('filters search results with highlights and shows the empty state when nothing matches', async () => {
    mountMenu(initialState());
    const input = host.querySelector<HTMLInputElement>('.mqm-search__input')!;
    input.value = 'claude';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    const resultRows = rows();
    expect(resultRows).toHaveLength(2);
    expect(resultRows[0]?.querySelector('.mqm-match')?.textContent).toBe('Claude');
    input.value = 'nonexistent-model';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    expect(host.textContent).toContain('没有匹配的模型');
  });

  it('requires choosing an effort in the search result submenu, then exits search and emits a staged selection', async () => {
    mountMenu(initialState());
    const input = host.querySelector<HTMLInputElement>('.mqm-search__input')!;
    input.value = 'sonnet';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    host.querySelector<HTMLElement>('[data-row-key="search:openrouter/sonnet"]')!.click();
    await nextTick();
    expect(actions).toEqual([]);
    const flyout = host.querySelector('.mqm-flyout')!;
    expect(flyout.textContent).toContain('Claude Sonnet 4.5');
    expect(flyout.textContent).toContain('思考强度');
    expect(flyout.querySelectorAll('.mqm-row svg')).toHaveLength(0);
    const options = [...flyout.querySelectorAll<HTMLElement>('.mqm-row')];
    options.at(-1)!.click();
    await nextTick();
    expect(actions).toEqual([{ type: 'select-model', modelId: 'openrouter/sonnet', effort: 'high', fromSearch: true }]);
    expect(input.value).toBe('');
    expect(host.querySelector('.mqm-flyout')).toBeNull();
    expect(host.querySelector('[data-row-key="recent:openrouter/sonnet"]')).not.toBeNull();
  });

  it('checks the current effort in the search submenu only when the result is the active model', async () => {
    mountMenu(initialState());
    const input = host.querySelector<HTMLInputElement>('.mqm-search__input')!;
    input.value = 'Kimi K2.5';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    host.querySelector<HTMLElement>('[data-row-key="search:kimi/k2.5"]')!.click();
    await nextTick();
    const checked = host.querySelector('.mqm-flyout .mqm-row[aria-checked="true"]');
    expect(checked?.textContent?.trim()).toBe('High');
  });

  it('stages non-thinking search results on click without a submenu and returns to the main list', async () => {
    mountMenu(initialState());
    const input = host.querySelector<HTMLInputElement>('.mqm-search__input')!;
    input.value = 'haiku';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    host.querySelector<HTMLElement>('[data-row-key="search:openrouter/haiku"]')!.click();
    await nextTick();
    expect(host.querySelector('.mqm-flyout')).toBeNull();
    expect(input.value).toBe('');
    expect(actions).toEqual([{ type: 'select-model', modelId: 'openrouter/haiku', fromSearch: true }]);
  });

  it('closes the submenu on first Escape and dismisses the menu on second Escape', async () => {
    mountMenu(initialState());
    const root = host.querySelector<HTMLElement>('.mqm')!;
    host.querySelector<HTMLElement>('[data-row-key="action:provider"]')!.click();
    await nextTick();
    expect(host.querySelector('.mqm-flyout')).not.toBeNull();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(host.querySelector('.mqm-flyout')).toBeNull();
    expect(dismissed).toBe(0);
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dismissed).toBe(1);
  });

  it('keeps every configured provider reachable in the scrolling provider submenu', async () => {
    const providers = Array.from({ length: 12 }, (_, index) => ({ id: `provider-${index + 1}`, label: `Provider ${index + 1}` }));
    mountMenu(initialState({ providers }));
    host.querySelector<HTMLElement>('[data-row-key="action:provider"]')!.click();
    await nextTick();

    const options = [...host.querySelectorAll<HTMLElement>('.mqm-flyout .mqm-submenu-scroll .mqm-row')];
    expect(options).toHaveLength(12);
    expect(options.at(-1)?.textContent?.trim()).toBe('Provider 12');
    options.at(-1)!.click();
    await nextTick();
    expect(actions).toEqual([{ type: 'select-provider', providerId: 'provider-12' }]);
  });

  it('renders a draggable 4px overlay thumb with edge fades instead of the native scrollbar', async () => {
    const manyModels = Array.from({ length: 10 }, (_, i) => ({
      id: `openrouter/m${i}`,
      provider: 'openrouter',
      model: `m${i}`,
      displayName: `Model ${i}`,
      maxContextSize: 128 * 1024,
      capabilities: ['tool_use'],
    }));
    mountMenu(initialState({ providerModels: manyModels }));
    await nextTick();
    await nextTick();
    const scroller = host.querySelector<HTMLElement>('.mqm-provider-scroll')!;
    scroller.style.setProperty('--overlay-scrollbar-track-inset', '2px');
    scroller.style.setProperty('--overlay-scrollbar-thumb-min', '24px');
    let scrollTopValue = 0;
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, get: () => scrollTopValue, set: (value) => { scrollTopValue = value; } },
      scrollHeight: { configurable: true, value: 320 },
      clientHeight: { configurable: true, value: 192 },
      offsetTop: { configurable: true, value: 200 },
    });
    scroller.dispatchEvent(new MouseEvent('mouseenter'));
    scroller.dispatchEvent(new Event('scroll'));
    await nextTick();

    const thumb = () => host.querySelector<HTMLElement>('.model-scroll-thumb');
    expect(thumb()).not.toBeNull();
    expect(thumb()?.classList.contains('is-visible')).toBe(true);
    expect(thumb()?.style.height).toBe('112.8px');
    expect(thumb()?.style.top).toBe('202px');
    expect(scroller.style.maskImage).toContain('to top');

    scrollTopValue = 64;
    scroller.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(scroller.style.maskImage).toContain('to bottom');
    expect(scroller.style.maskImage).toContain('calc(100% - var(--menu-scroll-fade, 20px))');
    expect(thumb()?.style.top).not.toBe('202px');

    scroller.dispatchEvent(new MouseEvent('mouseleave'));
    await vi.advanceTimersByTimeAsync(950);
    await nextTick();
    expect(thumb()?.classList.contains('is-visible')).toBe(false);
  });

  it('keeps recent models, provider label, actions, and search fixed while only the provider list scrolls', async () => {
    mountMenu(initialState());
    const menu = host.querySelector<HTMLElement>('.mqm')!;
    expect(menu.style.maxHeight).toBe('480px');
    expect(menu.querySelectorAll(':scope > .mqm-body > .mqm-recent-scroll > .mqm-row')).toHaveLength(3);
    expect(menu.querySelector(':scope > .mqm-body > .mqm-label')?.textContent?.trim()).toBe('最近使用');
    expect(menu.querySelectorAll(':scope > .mqm-body > .mqm-provider-scroll > .mqm-row')).toHaveLength(3);
    expect(menu.querySelector(':scope .mqm-provider-scroll [data-row-key^="recent:"]')).toBeNull();
    expect(menu.querySelector(':scope > .mqm-actions')).not.toBeNull();
    expect(menu.querySelector(':scope > .mqm-search')).not.toBeNull();
  });

  it('falls back to a single scrollable upper body when maxHeight cannot fit the fixed chrome', () => {
    const fiveRecent = [...kimiModels, ...otherModels].slice(0, 5);
    mountMenu(initialState({ recentModels: fiveRecent }), 220);
    const menu = host.querySelector<HTMLElement>('.mqm')!;
    const body = menu.querySelector<HTMLElement>('.mqm-body.is-fluid')!;
    expect(menu.style.maxHeight).toBe('220px');
    expect(body).not.toBeNull();
    expect(body.querySelectorAll('[data-row-key^="recent:"]')).toHaveLength(5);
    expect(body.querySelectorAll('[data-row-key^="provider:"]')).toHaveLength(3);
    expect(menu.querySelector(':scope > .mqm-actions [data-row-key="action:provider"]')).not.toBeNull();
    expect(menu.querySelector(':scope > .mqm-search input')).not.toBeNull();
  });
});
