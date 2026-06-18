import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import ConversationPane from '../src/components/ConversationPane.vue';
import ChatDock from '../src/components/ChatDock.vue';
import type { ChatTurn, ConversationStatus, UIQuestion } from '../src/types';

// These tests verify USER-OBSERVABLE follow/scroll behaviour through the real
// ConversationPane (+ real ChatDock so the composer / question / approval / pill
// all render). The only test doubles are the heavy leaf renderers and a
// controllable ResizeObserver — jsdom ships no ResizeObserver, and the dock /
// content-column resize path can only be exercised by firing its callback.

const status: ConversationStatus = {
  model: 'kimi-test',
  modelId: 'kimi-test',
  ctxUsed: 0,
  ctxMax: 0,
  permission: 'manual',
  branch: 'main',
  cwd: '/repo',
  isGitRepo: true,
};

let resizeCallbacks: ResizeObserverCallback[] = [];
class MockResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    resizeCallbacks.push(cb);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
/** Simulate a layout resize (dock grew, image loaded, window resized, …). */
function fireResize(): void {
  for (const cb of resizeCallbacks) cb([], {} as ResizeObserver);
}

function mountMobilePane(extraProps: Record<string, unknown>) {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: {} },
    missingWarn: false,
    fallbackWarn: false,
  });
  return mount(ConversationPane, {
    attachTo: document.body,
    props: {
      mobile: true,
      turns: [],
      tasks: [],
      status,
      fileReloadKey: 'sess_1',
      sessionLoading: false,
      running: false,
      ...extraProps,
    },
    global: {
      plugins: [i18n],
      // ChatDock is rendered for real (composer/question/approval/pill paths);
      // only the heavy leaf renderers are stubbed.
      stubs: {
        ChatHeader: true,
        ChatPane: true,
        Composer: true,
        GoalStrip: true,
        TasksPane: true,
        TodoCard: true,
        Terminal: true,
        SwarmCard: true,
      },
    },
  });
}

/** Mock the scroll geometry of a scroller. scrollHeight/clientHeight are read
    from `geo` live (so a test can grow scrollHeight across frames); scrollTop is
    a real writable value the component sets. */
function mockPaneGeometry(
  el: HTMLElement,
  geo: { scrollHeight: number; clientHeight: number; scrollTop: number },
): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geo.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geo.clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: geo.scrollTop });
}

function turn(no: number, text: string, extra: Partial<ChatTurn> = {}): ChatTurn {
  return { id: `t${no}`, role: no % 2 ? 'user' : 'assistant', no, text, ...extra };
}

function question(id: string): UIQuestion {
  return {
    questionId: id,
    sessionId: 'sess_1',
    questions: [{ id: `${id}_q`, question: 'Pick one?', options: [{ id: 'o1', label: 'One' }] }],
  };
}

let realResizeObserver: typeof globalThis.ResizeObserver | undefined;

beforeEach(() => {
  resizeCallbacks = [];
  realResizeObserver = globalThis.ResizeObserver;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockReturnValue(100_000);
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  if (realResizeObserver) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realResizeObserver;
  } else {
    // jsdom ships no ResizeObserver — remove the mock instead of leaving it behind.
    delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Mount, let the initial stable-follow loop settle, then return the (geometry-
    mocked) scroller pre-positioned at the bottom and "following". */
async function settledPane(geo: { scrollHeight: number; clientHeight: number }, props: Record<string, unknown> = {}) {
  const wrapper = mountMobilePane({ turns: [turn(1, 'hi')], ...props });
  await nextTick();
  vi.advanceTimersByTime(200); // initial scheduleStableFollow loop completes
  await nextTick();

  const pane = wrapper.find('.chat-scroll').element as HTMLElement;
  const g = { ...geo, scrollTop: geo.scrollHeight - geo.clientHeight };
  mockPaneGeometry(pane, g);
  // A scroll event at the bottom syncs the baseline; following stays on.
  pane.dispatchEvent(new Event('scroll'));
  await nextTick();
  return { wrapper, pane, geo: g };
}

/** Push new turns and fully settle: the scrollKey watcher's own `await nextTick`
    plus the follow-up re-render both need to flush before the pill / scroll
    position reflect the change. */
async function pushTurns(wrapper: ReturnType<typeof mountMobilePane>, turns: ChatTurn[]) {
  await wrapper.setProps({ turns });
  await nextTick();
  await nextTick();
  vi.advanceTimersByTime(40);
  await nextTick();
}

/** Simulate the user scrolling the pane up out of the bottom zone. */
function scrollUpTo(pane: HTMLElement, top: number): void {
  pane.scrollTop = top;
  pane.dispatchEvent(new Event('scroll'));
}

describe('ConversationPane follow — user scrolls up (req 2)', () => {
  it('stops auto-follow and shows the pill instead of yanking the view back', async () => {
    const { wrapper, pane, geo } = await settledPane({ scrollHeight: 2000, clientHeight: 500 });

    // User scrolls up to read history, then new streaming content arrives.
    scrollUpTo(pane, 300);
    await nextTick();
    await pushTurns(wrapper, [turn(1, 'hi'), turn(2, 'streaming…')]);

    // The view is NOT pulled back to the bottom; the pill appears instead.
    expect(pane.scrollTop).toBe(300);
    expect(wrapper.find('.newmsg-pill').exists()).toBe(true);

    // Returning to the bottom zone re-arms the follow; new content pins again.
    pane.scrollTop = geo.scrollHeight - geo.clientHeight;
    pane.dispatchEvent(new Event('scroll'));
    await nextTick();
    pane.scrollTop = 100; // pretend a later reflow left us short
    await pushTurns(wrapper, [turn(1, 'hi'), turn(2, 'streaming… more')]);

    expect(pane.scrollTop).toBe(2000);
    expect(wrapper.find('.newmsg-pill').exists()).toBe(false);
  });
});

describe('ConversationPane follow — user intent jumps to bottom (req 1)', () => {
  it('sending a message returns to the bottom and resumes following', async () => {
    const { wrapper, pane } = await settledPane({ scrollHeight: 2000, clientHeight: 500 });

    // Scroll up + let new content raise the pill.
    scrollUpTo(pane, 200);
    await nextTick();
    await pushTurns(wrapper, [turn(1, 'hi'), turn(2, 'reply')]);
    expect(pane.scrollTop).toBe(200);
    expect(wrapper.find('.newmsg-pill').exists()).toBe(true);

    // User sends a message.
    pane.scrollTop = 200;
    wrapper.findComponent(ChatDock).vm.$emit('submit', { text: 'next', attachments: [] });
    await nextTick();
    vi.advanceTimersByTime(60);
    await nextTick();

    expect(pane.scrollTop).toBe(2000);
    expect(wrapper.find('.newmsg-pill').exists()).toBe(false);
    expect(wrapper.emitted('submit')).toBeTruthy();

    // Following resumed: subsequent streaming keeps it pinned.
    pane.scrollTop = 100;
    await pushTurns(wrapper, [turn(1, 'hi'), turn(2, 'reply'), turn(3, 'more')]);
    expect(pane.scrollTop).toBe(2000);
  });

  it('answering a question returns to the bottom', async () => {
    const { wrapper, pane } = await settledPane(
      { scrollHeight: 2000, clientHeight: 500 },
      { questions: [question('q1')] },
    );

    pane.scrollTop = 150;
    pane.dispatchEvent(new Event('scroll'));
    await nextTick();

    wrapper.findComponent(ChatDock).vm.$emit('answer', 'q1', { kind: 'option', optionId: 'o1' });
    await nextTick();
    vi.advanceTimersByTime(60);
    await nextTick();

    expect(pane.scrollTop).toBe(2000);
  });

  it('clicking the new-messages pill scrolls smoothly to the bottom and resumes following (req 7)', async () => {
    const { wrapper, pane } = await settledPane({ scrollHeight: 2000, clientHeight: 500 });
    const scrollToSpy = vi.fn();
    (pane as unknown as { scrollTo: typeof scrollToSpy }).scrollTo = scrollToSpy;

    // Scroll up so the pill can appear, then bring in new content.
    scrollUpTo(pane, 200);
    await nextTick();
    await pushTurns(wrapper, [turn(1, 'hi'), turn(2, 'reply')]);
    expect(wrapper.find('.newmsg-pill').exists()).toBe(true);

    await wrapper.find('.newmsg-pill').trigger('click');
    await nextTick();

    // Pill jump is the ONE place that uses smooth scrolling.
    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    expect(wrapper.find('.newmsg-pill').exists()).toBe(false);

    // A delayed scroll event from the smooth animation must NOT be mistaken for a
    // user up-scroll (same performance.now → inside the 100ms guard window).
    pane.scrollTop = 1200; // mid-animation position, below the bottom
    pane.dispatchEvent(new Event('scroll'));
    await nextTick();

    // Following stayed on: new content pins synchronously (no smooth scroll).
    scrollToSpy.mockClear();
    pane.scrollTop = 100;
    await pushTurns(wrapper, [turn(1, 'hi'), turn(2, 'reply'), turn(3, 'more')]);
    expect(pane.scrollTop).toBe(2000);
    expect(scrollToSpy).not.toHaveBeenCalled();
  });
});

describe('ConversationPane follow — content changes keep the view pinned (req 3)', () => {
  it('follows new turns, text/thinking/tool streaming, and approvals while following', async () => {
    const { wrapper, pane } = await settledPane({ scrollHeight: 2000, clientHeight: 500 });

    async function expectPinnedAfter(props: Record<string, unknown>) {
      pane.scrollTop = 100; // a reflow left the view short of the bottom
      await wrapper.setProps(props);
      await nextTick();
      vi.advanceTimersByTime(40);
      await nextTick();
      expect(pane.scrollTop).toBe(2000);
    }

    await expectPinnedAfter({ turns: [turn(1, 'hi'), turn(2, 'a')] }); // new turn
    await expectPinnedAfter({ turns: [turn(1, 'hi'), turn(2, 'a longer streamed body')] }); // text stream
    await expectPinnedAfter({ turns: [turn(1, 'hi'), turn(2, 'a longer streamed body', { thinking: 'pondering deeply' })] }); // thinking
    await expectPinnedAfter({
      turns: [turn(1, 'hi'), turn(2, 'a longer streamed body', {
        thinking: 'pondering deeply',
        tools: [{ id: 'k1', name: 'bash', arg: 'ls', status: 'ok', output: ['one', 'two'] }],
      })],
    }); // tool args + output
    await expectPinnedAfter({ approvals: [{ approvalId: 'ap1', block: { kind: 'generic', summary: 'run it' } }] }); // approval
  });

  it('re-pins after a turn finishes running (final markdown / highlight reflow)', async () => {
    const { wrapper, pane } = await settledPane({ scrollHeight: 2000, clientHeight: 500 }, { running: true });

    pane.scrollTop = 100; // final reflow left it short
    await wrapper.setProps({ running: false });
    await nextTick();
    vi.advanceTimersByTime(80);
    await nextTick();

    expect(pane.scrollTop).toBe(2000);
  });
});

describe('ConversationPane follow — layout changes re-pin (req 4)', () => {
  it('re-pins when the bottom dock grows (question replaces the composer)', async () => {
    const { wrapper, pane } = await settledPane({ scrollHeight: 2000, clientHeight: 500 });

    // A question replaces the composer → the dock grows and shrinks the
    // viewport with no scroll/content event; only a ResizeObserver sees it.
    await wrapper.setProps({ questions: [question('q1')] });
    await nextTick();
    pane.scrollTop = 100; // dock growth left the latest content hidden behind it
    fireResize();
    await nextTick();
    vi.advanceTimersByTime(40);
    await nextTick();

    expect(pane.scrollTop).toBe(2000);
  });

  it('does not yank the view on resize when the user has scrolled up', async () => {
    const { wrapper, pane } = await settledPane({ scrollHeight: 2000, clientHeight: 500 });

    pane.scrollTop = 300;
    pane.dispatchEvent(new Event('scroll')); // following off
    await nextTick();

    fireResize(); // a resize must not pull a reading user back down
    await nextTick();
    vi.advanceTimersByTime(40);
    await nextTick();

    expect(pane.scrollTop).toBe(300);
  });
});

describe('ConversationPane follow — re-pin across frames until stable (req 6)', () => {
  it('keeps re-pinning as the tail height grows over several frames after a send', async () => {
    const wrapper = mountMobilePane({ turns: [turn(1, 'hi')] });
    await nextTick();
    vi.advanceTimersByTime(200);
    await nextTick();

    const pane = wrapper.find('.chat-scroll').element as HTMLElement;
    const geo = { scrollHeight: 2000, clientHeight: 500, scrollTop: 100 };
    mockPaneGeometry(pane, geo);

    wrapper.findComponent(ChatDock).vm.$emit('submit', { text: 'go', attachments: [] });
    await nextTick();

    // The tail keeps growing across the next few frames (markdown, images, code
    // highlight). A single scroll would leave the view short; the stable-follow
    // loop must keep pinning until the height settles.
    vi.advanceTimersByTime(16);
    geo.scrollHeight = 2600;
    vi.advanceTimersByTime(16);
    geo.scrollHeight = 3200;
    vi.advanceTimersByTime(16);
    await nextTick();
    vi.advanceTimersByTime(120); // height now stable → loop converges
    await nextTick();

    expect(pane.scrollTop).toBe(3200);
  });
});
