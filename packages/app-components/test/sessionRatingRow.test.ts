// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { AppSessionRatingResponse, AppSessionRatingView } from '@moonshot-ai/app-core/api';
import SessionRatingRow from '../src/chat/SessionRatingRow.vue';

type RatingView = Exclude<AppSessionRatingView, { phase: 'closed' }>;

const QUESTION = 'How’s Kimi doing in this session?';
const OPEN: RatingView = { phase: 'open', appearanceId: 'a1', survey: 'session' };

function pendingView(response: AppSessionRatingResponse = 'good'): RatingView {
  return { phase: 'pending', appearanceId: 'a1', survey: 'session', response };
}

function thanksView(response: AppSessionRatingResponse = 'good'): RatingView {
  return { phase: 'thanks', appearanceId: 'a1', survey: 'session', response };
}

let app: App | null = null;
let host: HTMLDivElement;
let animateSpy: ReturnType<typeof vi.fn>;
const shown = vi.fn<(appearanceId: string) => void>();
const select = vi.fn<(response: AppSessionRatingResponse) => void>();
const undo = vi.fn<() => void>();
const current = ref<RatingView>(OPEN);

let viewportObserver: MockIntersectionObserver | undefined;

class MockIntersectionObserver {
  private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void;
  private disconnected = false;

  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    this.callback = callback;
    viewportObserver = this;
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }

  fire(visible: boolean): void {
    if (this.disconnected) return;
    this.callback([{ isIntersecting: visible }]);
  }
}

function stubMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function mount(initial: RatingView): void {
  current.value = initial;
  app = createApp({
    render: () => h(SessionRatingRow, { view: current.value, onShown: shown, onSelect: select, onUndo: undo }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
}

function setView(view: RatingView): void {
  current.value = view;
}

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
  await nextTick();
}

function face(response: AppSessionRatingResponse): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`.sr-face[data-response="${response}"]`)!;
}

function faces(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('.sr-face'));
}

function keydown(key: string, target?: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  (target ?? host.querySelector('.session-rating')!).dispatchEvent(event);
  return event;
}

function chosenFace(): Element {
  return host.querySelector('.sr-chosen .kimi-face')!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  stubMotion(false);
  viewportObserver = undefined;
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  animateSpy = vi.fn(() => ({ cancel: vi.fn() }));
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, writable: true, value: animateSpy });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (Element.prototype as { animate?: unknown }).animate;
});

describe('SessionRatingRow phases', () => {
  it('shows the question and three labelled faces while open', async () => {
    mount(OPEN);
    await settle();
    expect(host.querySelector('.sr-question')?.textContent).toBe(QUESTION);
    expect(faces().map((button) => button.getAttribute('aria-label'))).toEqual(['Bad', 'Fine', 'Good']);
    expect(host.querySelector('.sr-thanks')).toBeNull();
    expect(host.querySelector('.sr-undo')).toBeNull();
  });

  it('shows thanks, the undo action and the chosen solid face when pending', async () => {
    mount(pendingView('fine'));
    await settle();
    expect(host.querySelector('.sr-question')).toBeNull();
    expect(faces()).toHaveLength(0);
    expect(host.querySelector('.sr-chosen')?.getAttribute('aria-label')).toBe('Fine');
    expect(chosenFace().classList.contains('solid')).toBe(true);
    expect(host.querySelector('.sr-thanks')?.textContent).toBe('Thanks for your feedback');
    expect(host.querySelector('.sr-undo')?.textContent).toContain('Undo');
  });

  it('keeps the thanks text and fades the undo action once settled', async () => {
    mount(pendingView('fine'));
    await settle();
    expect(host.querySelector('.session-rating')!.classList.contains('settled')).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('.sr-undo')!.disabled).toBe(false);
    setView(thanksView('fine'));
    await settle();
    expect(host.querySelector('.sr-thanks')?.textContent).toBe('Thanks for your feedback');
    expect(host.querySelector('.session-rating')!.classList.contains('settled')).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.sr-undo')!.disabled).toBe(true);
    expect(host.querySelector('.sr-undo')!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('SessionRatingRow shown reporting', () => {
  it('does not emit shown while the row is outside the viewport', async () => {
    mount(OPEN);
    await settle();
    viewportObserver?.fire(false);
    expect(shown).not.toHaveBeenCalled();
  });

  it('emits shown once the row enters the viewport', async () => {
    mount(OPEN);
    await settle();
    viewportObserver?.fire(false);
    viewportObserver?.fire(true);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith('a1');
  });

  it('emits shown at most once for an appearance', async () => {
    mount(OPEN);
    await settle();
    viewportObserver?.fire(true);
    viewportObserver?.fire(true);
    expect(shown).toHaveBeenCalledTimes(1);
  });
});

describe('SessionRatingRow entrance guard', () => {
  it('ignores clicks during the first 600ms', async () => {
    mount(OPEN);
    await settle();
    face('good').click();
    expect(select).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    face('good').click();
    expect(select).toHaveBeenCalledWith('good');
  });
});

describe('SessionRatingRow keyboard', () => {
  beforeEach(async () => {
    mount(OPEN);
    await settle();
    await vi.advanceTimersByTimeAsync(600);
  });

  it('does not select with digit keys', () => {
    keydown('1', faces()[0]!);
    keydown('2', faces()[1]!);
    keydown('3', faces()[2]!);
    expect(select).not.toHaveBeenCalled();
  });

  it('moves focus across faces with arrow keys and wraps around', () => {
    const buttons = faces();
    buttons[0]!.focus();
    keydown('ArrowRight', buttons[0]!);
    expect(document.activeElement).toBe(buttons[1]);
    keydown('ArrowLeft', buttons[1]!);
    expect(document.activeElement).toBe(buttons[0]);
    keydown('ArrowLeft', buttons[0]!);
    expect(document.activeElement).toBe(buttons[2]);
    keydown('ArrowRight', buttons[2]!);
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('does nothing on Escape while open', () => {
    const event = keydown('Escape', faces()[0]!);
    expect(undo).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('SessionRatingRow undo', () => {
  it('emits undo on Escape while pending', async () => {
    mount(pendingView());
    await settle();
    keydown('Escape', host.querySelector('.sr-undo')!);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('emits undo when the undo button is clicked', async () => {
    mount(pendingView());
    await settle();
    host.querySelector<HTMLButtonElement>('.sr-undo')!.click();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('does not emit undo on Escape once settled', async () => {
    mount(thanksView());
    await settle();
    keydown('Escape');
    expect(undo).not.toHaveBeenCalled();
  });
});

describe('SessionRatingRow answer animation', () => {
  async function answer(): Promise<void> {
    mount(OPEN);
    await settle();
    await vi.advanceTimersByTimeAsync(600);
    face('good').click();
    expect(select).toHaveBeenCalledWith('good');
    setView(pendingView('good'));
    await settle();
  }

  it('keeps the question and all faces during the pick beat, then flies and lands solid', async () => {
    await answer();
    expect(host.querySelector('.sr-question')?.textContent).toBe(QUESTION);
    expect(faces()).toHaveLength(3);
    expect(host.querySelector('.sr-thanks')).toBeNull();

    await vi.advanceTimersByTimeAsync(150);
    await settle();
    expect(host.querySelector('.sr-question')).toBeNull();
    expect(host.querySelector('.sr-ghost')?.textContent).toBe(QUESTION);
    expect(host.querySelector('.sr-thanks')?.textContent).toBe('Thanks for your feedback');
    expect(chosenFace().classList.contains('solid')).toBe(false);
    expect(animateSpy.mock.contexts[0]).toBe(chosenFace());
    expect(animateSpy.mock.calls[0]).toEqual([
      [
        { transform: 'translate(0px, 0px) rotate(0deg)', offset: 0 },
        { transform: 'translate(0px, -10px) rotate(-8deg)', offset: 0.46 },
        { transform: 'translate(-1.5px, 0px) rotate(2deg)', offset: 0.84 },
        { transform: 'translate(0px, 0px) rotate(0deg)', offset: 1 },
      ],
      { duration: 480, easing: 'cubic-bezier(.3, .7, .3, 1)' },
    ]);

    await vi.advanceTimersByTimeAsync(320);
    await settle();
    expect(host.querySelector('.sr-ghost')).toBeNull();
    expect(chosenFace().classList.contains('solid')).toBe(false);

    await vi.advanceTimersByTimeAsync(160);
    await settle();
    expect(chosenFace().classList.contains('solid')).toBe(true);
    expect(host.querySelector('.sr-burst')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(720);
    await settle();
    expect(chosenFace().classList.contains('blink')).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(chosenFace().classList.contains('blink')).toBe(false);
    expect(host.querySelector('.sr-burst')).toBeNull();
  });

  it('ignores further clicks once an answer is in flight', async () => {
    await answer();
    face('bad').click();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('moves focus to the undo action when answering with focus inside the row', async () => {
    mount(OPEN);
    await settle();
    await vi.advanceTimersByTimeAsync(600);
    faces()[0]!.focus();
    face('good').click();
    setView(pendingView('good'));
    await settle();
    await vi.advanceTimersByTimeAsync(150);
    await settle();
    const undoButton = host.querySelector('.sr-undo')!;
    expect(document.activeElement).toBe(undoButton);
    keydown('Escape', undoButton);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('returns to the question when undone mid-flight and stays there', async () => {
    await answer();
    await vi.advanceTimersByTimeAsync(150);
    await settle();
    setView(OPEN);
    await settle();
    expect(host.querySelector('.sr-question')?.textContent).toBe(QUESTION);
    expect(faces()).toHaveLength(3);
    expect(host.querySelector('.sr-ghost')).toBeNull();
    expect(host.querySelector('.sr-thanks')).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(host.querySelector('.sr-question')).not.toBeNull();
    expect(host.querySelector('.sr-thanks')).toBeNull();
    face('fine').click();
    expect(select).toHaveBeenCalledWith('fine');
  });

  it('skips the animation and switches straight to the result when reduced motion is on', async () => {
    stubMotion(true);
    mount(OPEN);
    await settle();
    await vi.advanceTimersByTimeAsync(600);
    face('good').click();
    setView(pendingView('good'));
    await settle();
    expect(host.querySelector('.sr-question')).toBeNull();
    expect(faces()).toHaveLength(0);
    expect(host.querySelector('.sr-thanks')?.textContent).toBe('Thanks for your feedback');
    expect(chosenFace().classList.contains('solid')).toBe(true);
    expect(host.querySelector('.sr-ghost')).toBeNull();
    expect(animateSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(host.querySelector('.sr-burst')).toBeNull();
  });
});
