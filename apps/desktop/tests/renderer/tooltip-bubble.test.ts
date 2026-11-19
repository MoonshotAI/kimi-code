// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';

import IconButton from '../../../../packages/app-ui/src/components/ui/IconButton.vue';
import TooltipBubble from '../../../../packages/app-ui/src/components/ui/TooltipBubble.vue';
import { IconResolverKey } from '../../../../packages/app-ui/src/icons';

const TEXT = '关闭右侧面板';
const PREFERRED_WIDTH = 100;
const BUBBLE_HEIGHT = 20;

let app: App | undefined;
let target: HTMLButtonElement;
let appHost: HTMLDivElement;
let pointerX = 0;
let measuredWidths: number[];

function setViewport(width: number, height = 768): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

function mockBubbleLayout(): void {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains('ui-tip__bubble')) return 0;
    const left = Number.parseFloat(this.style.left);
    const available = Number.isNaN(left) ? window.innerWidth : window.innerWidth - left;
    const width = Math.min(PREFERRED_WIDTH, Math.max(0, available));
    measuredWidths.push(width);
    return width;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('ui-tip__bubble') ? BUBBLE_HEIGHT : 0;
  });
}

function bubble(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('.ui-tip__bubble');
  if (!el) throw new Error('bubble not mounted');
  return el;
}

function pointerMove(): void {
  pointerX += 17;
  target.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: pointerX, clientY: 15 }));
}

async function show(): Promise<void> {
  pointerMove();
  pointerMove();
  await vi.advanceTimersByTimeAsync(200);
  await nextTick();
}

async function hide(): Promise<void> {
  target.dispatchEvent(new MouseEvent('mouseleave'));
  await nextTick();
}

function mountBubble(props: Record<string, unknown>): void {
  const Root = defineComponent({ setup: () => () => h(TooltipBubble, { target, ...props }) });
  app = createApp(Root);
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name) =>
    defineComponent({ setup: () => () => h('svg', { class: 'stub-icon', 'data-icon': name }) }),
  );
  app.mount(appHost);
}

beforeEach(() => {
  vi.useFakeTimers();
  measuredWidths = [];
  setViewport(1024);
  mockBubbleLayout();
  target = document.createElement('button');
  target.getBoundingClientRect = () =>
    ({ left: 960, top: 10, width: 32, height: 32, right: 992, bottom: 42, x: 960, y: 10 }) as DOMRect;
  document.body.appendChild(target);
  appHost = document.createElement('div');
  document.body.appendChild(appHost);
  mountBubble({ text: TEXT });
});

afterEach(() => {
  vi.unstubAllGlobals();
  app?.unmount();
  app = undefined;
  target.remove();
  appHost.remove();
  document.body.querySelectorAll('.ui-tip__bubble').forEach((el) => el.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TooltipBubble positioning', () => {
  it('clamps to the viewport edge using the preferred width', async () => {
    await show();
    expect(bubble().classList.contains('positioned')).toBe(true);
    expect(bubble().style.left).toBe('916px');
    expect(bubble().style.top).toBe('48px');
    expect(bubble().style.maxWidth).toBe('280px');
    expect(measuredWidths).toEqual([PREFERRED_WIDTH]);
  });

  it('remeasures unconstrained after the viewport shrinks instead of narrowing step by step', async () => {
    await show();
    expect(bubble().style.left).toBe('916px');
    await hide();

    setViewport(800);
    window.dispatchEvent(new Event('resize'));

    await show();
    expect(measuredWidths).toEqual([PREFERRED_WIDTH, PREFERRED_WIDTH]);
    expect(bubble().style.left).toBe('692px');
  });
});

describe('TooltipBubble shortcut keys', () => {
  async function remountWithKeys(keys: string[]): Promise<void> {
    app?.unmount();
    app = undefined;
    document.body.querySelectorAll('.ui-tip__bubble').forEach((el) => el.remove());
    mountBubble({ text: TEXT, keys });
    await show();
  }

  it('renders the label and a Kbd row of key icons instead of glyph text', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    await remountWithKeys(['shift', 'mod', 'b']);
    const el = bubble();
    expect(el.classList.contains('ui-tip__bubble--keys')).toBe(true);
    expect(el.querySelector('.ui-tip__label')?.textContent).toBe(TEXT);
    const chips = el.querySelectorAll('.ui-kbd__key');
    expect(chips).toHaveLength(3);
    const icons = [...el.querySelectorAll('svg.stub-icon')].map((icon) => icon.getAttribute('data-icon'));
    expect(icons).toEqual(['key-shift', 'key-command']);
    expect(el.textContent).not.toContain('⇧');
    expect(el.textContent).not.toContain('⌘');
    expect(chips[2]?.textContent).toBe('B');
  });

  it('renders without the keys layout when no keys are given', async () => {
    await show();
    const el = bubble();
    expect(el.classList.contains('ui-tip__bubble--keys')).toBe(false);
    expect(el.querySelector('.ui-kbd')).toBeNull();
    expect(el.textContent).toBe(TEXT);
  });
});

describe('TooltipBubble text updates', () => {
  it('hides the open bubble when the text becomes empty', async () => {
    app?.unmount();
    app = undefined;
    document.body.querySelectorAll('.ui-tip__bubble').forEach((el) => el.remove());
    const text = ref<string | null>(TEXT);
    const Root = defineComponent({ setup: () => () => h(TooltipBubble, { target, text: text.value }) });
    app = createApp(Root);
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(IconResolverKey, (name) =>
      defineComponent({ setup: () => () => h('svg', { class: 'stub-icon', 'data-icon': name }) }),
    );
    app.mount(appHost);
    await show();
    expect(bubble().textContent).toBe(TEXT);

    text.value = null;
    await nextTick();
    expect(document.body.querySelector('.ui-tip__bubble')).toBeNull();
  });
});

describe('IconButton shortcut keys', () => {
  it('forwards the keys prop to its tooltip as key caps', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    app?.unmount();
    target.remove();
    const Root = defineComponent({
      setup: () => () => h(IconButton, { label: TEXT, tooltip: TEXT, keys: ['shift', 'mod', 'b'] }),
    });
    app = createApp(Root);
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(IconResolverKey, (name) =>
      defineComponent({ setup: () => () => h('svg', { class: 'stub-icon', 'data-icon': name }) }),
    );
    app.mount(appHost);
    await nextTick();
    const button = appHost.querySelector<HTMLButtonElement>('button.ui-icon-button');
    if (!button) throw new Error('icon button not mounted');
    button.getBoundingClientRect = () =>
      ({ left: 960, top: 10, width: 32, height: 32, right: 992, bottom: 42, x: 960, y: 10 }) as DOMRect;
    target = button;
    await show();

    const el = bubble();
    expect(button.hasAttribute('keys')).toBe(false);
    expect(el.classList.contains('ui-tip__bubble--keys')).toBe(true);
    expect([...el.querySelectorAll('svg.stub-icon')].map((icon) => icon.getAttribute('data-icon'))).toEqual([
      'key-shift',
      'key-command',
    ]);
  });
});
