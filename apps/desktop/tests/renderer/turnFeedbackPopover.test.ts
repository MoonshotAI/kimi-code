// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, provide, ref, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';

import TurnFeedbackActions from '../../src/renderer/components/feedback/TurnFeedbackActions.vue';
import TurnFeedbackPopover from '../../src/renderer/components/feedback/TurnFeedbackPopover.vue';
import { DesktopFeedbackKey, type FeedbackForm, type TurnFeedbackTarget } from '../../src/renderer/composables/useDesktopFeedback';

const target: TurnFeedbackTarget = { sessionId: 'example-session', turnId: 'turn-1', replyId: 'reply-1' };

const multiRowForm: FeedbackForm = {
  version: 1,
  reply_reasons: {
    negative: [
      { id: 'incorrect', label: { en: 'Incorrect or incomplete', zh: '结果不正确或不完整' } },
      { id: 'mismatch', label: { en: 'Claimed without doing', zh: '声明与执行脱节' } },
      { id: 'hallucination', label: { en: 'Hallucination', zh: '幻觉' } },
      { id: 'slow', label: { en: 'Too slow', zh: '响应太慢' } },
      { id: 'other', label: { en: 'Other', zh: '其他' } },
    ],
    positive: [{ id: 'helpful', label: { en: 'Helpful', zh: '有帮助' } }],
  },
};

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let app: App | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createFeedbackStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    accountEpoch: ref(0),
    clearHostAccount: vi.fn(),
    state: vi.fn(() => undefined),
    isPopoverOpen: vi.fn(() => false),
    closePopover: vi.fn(),
    peekForm: vi.fn(() => undefined),
    prefetchForm: vi.fn(),
    loadForm: vi.fn(async () => multiRowForm),
    requireLogin: vi.fn(() => true),
    submitGlobal: vi.fn(),
    chooseRating: vi.fn(),
    submitDetails: vi.fn(),
    ...overrides,
  };
}

describe('TurnFeedbackActions and TurnFeedbackPopover', () => {
  it('prefetches the feedback form when hovering or focusing either thumbs-up or thumbs-down', async () => {
    const feedback = createFeedbackStub();
    app = createApp(defineComponent({
      setup() {
        provide(DesktopFeedbackKey, feedback as never);
        return () => h(TurnFeedbackActions, { target });
      },
    }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(container);
    await nextTick();

    const up = container.querySelector<HTMLButtonElement>('button[aria-label="Good response"]');
    const down = container.querySelector<HTMLButtonElement>('button[aria-label="Poor response"]');
    expect(up).not.toBeNull();
    expect(down).not.toBeNull();

    up!.dispatchEvent(new Event('pointerenter'));
    up!.dispatchEvent(new Event('focus'));
    down!.dispatchEvent(new Event('pointerenter'));
    down!.dispatchEvent(new Event('focus'));

    expect(feedback.prefetchForm).toHaveBeenCalledTimes(4);
    expect(feedback.prefetchForm).toHaveBeenNthCalledWith(1, target.sessionId);
    expect(feedback.prefetchForm).toHaveBeenNthCalledWith(2, target.sessionId);
    expect(feedback.prefetchForm).toHaveBeenNthCalledWith(3, target.sessionId);
    expect(feedback.prefetchForm).toHaveBeenNthCalledWith(4, target.sessionId);
  });

  it('renders cached reasons immediately without loading state and preserves them if background refresh fails', async () => {
    let resolveRefresh!: (value: FeedbackForm | null) => void;
    const feedback = createFeedbackStub({
      peekForm: vi.fn(() => multiRowForm),
      loadForm: vi.fn(() => new Promise<FeedbackForm | null>(resolve => { resolveRefresh = resolve; })),
    });
    const anchor = document.createElement('button');
    container.append(anchor);

    app = createApp(defineComponent({
      setup() {
        provide(DesktopFeedbackKey, feedback as never);
        return () => h(TurnFeedbackPopover, { anchor, target, saving: false, updating: false });
      },
    }));
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(container);
    await nextTick();

    const group = container.querySelector<HTMLElement>('.feedback-reasons');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-busy')).toBeNull();
    expect(group?.querySelectorAll('button')).toHaveLength(multiRowForm.reply_reasons.negative.length);

    resolveRefresh(null);
    await Promise.resolve();
    await nextTick();

    expect(group?.querySelectorAll('button')).toHaveLength(multiRowForm.reply_reasons.negative.length);
  });

  it('lets reasons wrap naturally without a locked scrolling class after a slow load', async () => {
    let resolveForm!: (value: FeedbackForm | null) => void;
    const feedback = createFeedbackStub({
      peekForm: vi.fn(() => undefined),
      loadForm: vi.fn(() => new Promise<FeedbackForm | null>(resolve => { resolveForm = resolve; })),
    });
    const anchor = document.createElement('button');
    container.append(anchor);

    app = createApp(defineComponent({
      setup() {
        provide(DesktopFeedbackKey, feedback as never);
        return () => h(TurnFeedbackPopover, { anchor, target, saving: false, updating: false });
      },
    }));
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(container);
    await nextTick();

    const group = container.querySelector<HTMLElement>('.feedback-reasons');
    expect(group?.getAttribute('aria-busy')).toBe('true');
    expect(group?.classList.contains('feedback-reasons-loading-size')).toBe(false);

    resolveForm(multiRowForm);
    await Promise.resolve();
    await nextTick();

    expect(group?.getAttribute('aria-busy')).toBeNull();
    expect(group?.classList.contains('feedback-reasons-loading-size')).toBe(false);
    expect(Array.from(group?.querySelectorAll('button') ?? []).map(el => el.textContent)).toEqual(
      multiRowForm.reply_reasons.negative.map(reason => reason.label.zh),
    );
  });

  it('focuses the textarea when clicking the editor container or counter area', async () => {
    const feedback = createFeedbackStub({
      peekForm: vi.fn(() => multiRowForm),
      loadForm: vi.fn(async () => multiRowForm),
    });
    const anchor = document.createElement('button');
    container.append(anchor);

    app = createApp(defineComponent({
      setup() {
        provide(DesktopFeedbackKey, feedback as never);
        return () => h(TurnFeedbackPopover, { anchor, target, saving: false, updating: false });
      },
    }));
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(container);
    await nextTick();

    const popover = container.querySelector<HTMLElement>('.feedback-popover');
    const editorBox = container.querySelector<HTMLElement>('.feedback-editor');
    const count = container.querySelector<HTMLElement>('.feedback-count');
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(popover).not.toBeNull();
    expect(editorBox).not.toBeNull();
    expect(count).not.toBeNull();
    expect(textarea).not.toBeNull();

    expect(document.activeElement).toBe(popover);

    const onContainer = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    editorBox!.dispatchEvent(onContainer);
    expect(onContainer.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea);

    popover!.focus();
    expect(document.activeElement).toBe(popover);
    const onCounter = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    count!.dispatchEvent(onCounter);
    expect(onCounter.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea);

    const onTextarea = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    textarea!.dispatchEvent(onTextarea);
    expect(onTextarea.defaultPrevented).toBe(false);
  });
});
