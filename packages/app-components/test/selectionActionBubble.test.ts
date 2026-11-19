// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { useSelectionQuoteBubble } from '../../app-client/src/composables/useSelectionQuoteBubble';
import SelectionActionBubble from '../src/chat/SelectionActionBubble.vue';

const keyMocks = vi.hoisted(() => ({ apple: null as boolean | null, sendWithModifier: false }));

vi.mock('@moonshot-ai/app-core/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-core/lib')>();
  return { ...actual, isApplePlatform: () => keyMocks.apple ?? actual.isApplePlatform() };
});

vi.mock('@moonshot-ai/app-client/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/contracts')>();
  return {
    ...actual,
    resolveComposerBinding: ((name, ctx) =>
      name === 'send' && keyMocks.sendWithModifier
        ? { matches: (e: KeyboardEvent) => e.key === 'Enter' && (keyMocks.apple ? e.metaKey : e.ctrlKey) }
        : actual.resolveComposerBinding(name, ctx)) as typeof actual.resolveComposerBinding,
  };
});

let app: App;
let host: HTMLDivElement;
const close = vi.fn();
const action = vi.fn();
const keepOnContextClick = ref(false);

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(300);
  await nextTick();
}

function select(start: number, end: number): void {
  const node = host.querySelector('p')!.firstChild!;
  const range = document.createRange();
  range.getBoundingClientRect = () => ({ x: 20, y: 40, left: 20, top: 40, width: 100, height: 20, right: 120, bottom: 60, toJSON: () => ({}) });
  range.getClientRects = () => [{ left: 20, top: 40, right: 120, bottom: 60 }] as unknown as DOMRectList;
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

function mouse(target: Element, detail: number, button = 0, clientX = 0, clientY = 0): void {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button }));
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail, button, clientX, clientY }));
  target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button }));
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, detail, button }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  keepOnContextClick.value = false;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    setup() {
      const root = ref<HTMLElement | null>(null);
      const q = useSelectionQuoteBubble({ root, containerSelector: '.quote-body', onAction: action });
      return () => [
        h('div', { ref: root, onPointerdown: q.onPointerdown, onMouseup: q.onMouseup }, [
          h('p', { class: 'quote-body' }, 'Selected paragraph'),
          h('button', { id: 'outside' }, 'Outside'),
        ]),
        h(SelectionActionBubble, {
          visible: q.selectionBubble.value !== null,
          x: q.selectionBubble.value?.x ?? 0,
          y: q.selectionBubble.value?.y ?? 0,
          bottom: q.selectionBubble.value?.bottom ?? 0,
          quote: q.selectionBubble.value?.quote ?? '',
          keepOnContextClick: keepOnContextClick.value,
          onClose: () => { close(); q.onBubbleClose(); },
          onAction: q.onBubbleAction,
        }),
      ];
    },
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
});

afterEach(() => {
  keyMocks.apple = null;
  keyMocks.sendWithModifier = false;
  app.unmount();
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('selection bubble multi-click selection', () => {
  it('keeps an already visible bubble when triple click does not change the selection', async () => {
    select(0, 18);
    await settle();
    expect(document.querySelector('.sab')).not.toBeNull();
    mouse(host.querySelector('p')!, 3);
    await settle();
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector('.sab')).not.toBeNull();
  });

  it('updates the quote from word to paragraph without closing the bubble', async () => {
    select(0, 8);
    await settle();
    mouse(host.querySelector('p')!, 3);
    select(0, 18);
    await settle();
    expect(close).not.toHaveBeenCalled();
    const add = Array.from(document.querySelectorAll<HTMLButtonElement>('.sab button')).find(button => button.textContent?.includes('Add to chat'))!;
    expect(add).toBeDefined();
    add.click();
    expect(action.mock.calls[0]?.[0]).toMatchObject({ action: 'quote', quote: 'Selected paragraph' });
  });

  it.each([1, 2, 3])('still dismisses on an outside control with click count %i', async (detail) => {
    select(0, 8);
    await settle();
    mouse(host.querySelector('#outside')!, detail);
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector('.sab')).toBeNull();
  });

  it.each([{ detail: 1, button: 0 }, { detail: 3, button: 2 }])('still dismisses ordinary or right clicks on selected text: %o', async ({ detail, button }) => {
    select(0, 8);
    await settle();
    mouse(host.querySelector('p')!, detail, button);
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector('.sab')).toBeNull();
  });

  it('keeps the bubble through a context click on the selection when opted in', async () => {
    keepOnContextClick.value = true;
    select(0, 8);
    await settle();
    mouse(host.querySelector('p')!, 1, 2, 50, 50);
    await settle();
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector('.sab')).not.toBeNull();
  });

  it('dismisses an opted-in bubble on a context click outside the selection', async () => {
    keepOnContextClick.value = true;
    select(0, 8);
    await settle();
    mouse(host.querySelector('p')!, 1, 2, 200, 50);
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector('.sab')).toBeNull();
  });

  it('still dismisses with Escape after a triple click', async () => {
    select(0, 18);
    await settle();
    mouse(host.querySelector('p')!, 3);
    await settle();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector('.sab')).toBeNull();
  });

  it('stays open when an outside container scrolls', async () => {
    select(0, 18);
    await settle();
    host.querySelector('p')!.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector('.sab')).not.toBeNull();
  });
});

describe('selection bubble comment keeps the selection visible', () => {
  const HIGHLIGHT_NAME = 'kimi-selection-comment-keep';

  function stubHighlightApi(): { set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> } {
    const set = vi.fn();
    const del = vi.fn();
    vi.stubGlobal('CSS', { highlights: { set, delete: del } });
    vi.stubGlobal('Highlight', class {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    });
    return { set, del };
  }

  function commentButton(): HTMLButtonElement {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.sab button')).find(button => button.textContent?.includes('Comment'))!;
  }

  function actionButtons(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.sab-actions button'));
  }

  async function enterComment(): Promise<void> {
    select(0, 18);
    await settle();
    commentButton().click();
    await settle();
  }

  it('re-paints the quoted range through the Custom Highlight API on comment entry', async () => {
    const { set } = stubHighlightApi();
    await enterComment();
    expect(set).toHaveBeenCalledOnce();
    const [name, highlight] = set.mock.calls[0]!;
    expect(name).toBe(HIGHLIGHT_NAME);
    expect((highlight as { ranges: Range[] }).ranges[0]?.toString()).toBe('Selected paragraph');
    expect(document.querySelector('.sab-input')).not.toBeNull();
    expect(document.activeElement?.classList.contains('sab-input')).toBe(true);
  });

  it('keeps the comment draft when an outside container scrolls', async () => {
    await enterComment();
    const input = document.querySelector<HTMLTextAreaElement>('.sab-input')!;
    input.value = 'keep this draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    host.querySelector('p')!.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLTextAreaElement>('.sab-input')?.value).toBe('keep this draft');
  });

  it('clears the kept highlight when the comment is confirmed', async () => {
    const { del } = stubHighlightApi();
    await enterComment();
    del.mockClear();
    const input = document.querySelector<HTMLTextAreaElement>('.sab-input')!;
    input.value = 'please fix this';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    actionButtons().find(button => button.textContent?.includes('Add to chat'))!.click();
    expect(del).toHaveBeenCalledWith(HIGHLIGHT_NAME);
    expect(action.mock.calls[0]?.[0]).toMatchObject({ action: 'comment', quote: 'Selected paragraph', comment: 'please fix this' });
  });

  it('clears the kept highlight when the comment is cancelled', async () => {
    const { del } = stubHighlightApi();
    await enterComment();
    del.mockClear();
    actionButtons().find(button => button.textContent?.includes('Cancel'))!.click();
    await settle();
    expect(del).toHaveBeenCalledWith(HIGHLIGHT_NAME);
    expect(close).toHaveBeenCalledOnce();
  });

  it('still enters comment mode when the Custom Highlight API is unavailable', async () => {
    await enterComment();
    expect(document.querySelector('.sab-input')).not.toBeNull();
    expect(document.activeElement?.classList.contains('sab-input')).toBe(true);
  });
});

describe('selection bubble add-to-chat key hint', () => {
  async function enterComment(): Promise<void> {
    select(0, 18);
    await settle();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sab button')).find(button => button.textContent?.includes('Comment'))!.click();
    await settle();
  }

  it('names the Ctrl key in words off Apple platforms', async () => {
    keyMocks.apple = false;
    keyMocks.sendWithModifier = true;
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    await enterComment();
    const hint = document.querySelector('.sab-enter');
    expect(hint?.textContent).toContain('Ctrl');
    expect(hint?.textContent).not.toContain('Control');
  });

  it('shows the Command key on Apple platforms', async () => {
    keyMocks.apple = true;
    keyMocks.sendWithModifier = true;
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    await enterComment();
    expect(document.querySelector('.sab-enter')?.textContent).toContain('Command');
  });
});
