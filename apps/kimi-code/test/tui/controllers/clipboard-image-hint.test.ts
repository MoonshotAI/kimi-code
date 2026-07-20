import type { TUI } from '@moonshot-ai/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClipboardImageHintController,
  type ClipboardImageHintHost,
} from '#/tui/controllers/clipboard-image-hint';
import type { FooterComponent } from '#/tui/components/chrome/footer';
import { TERMINAL_FOCUS_IN, TERMINAL_FOCUS_OUT } from '#/tui/utils/terminal-focus';
import { clipboardHasImage } from '#/utils/clipboard/clipboard-has-image';

vi.mock('#/utils/clipboard/clipboard-has-image', () => ({
  clipboardHasImage: vi.fn(async () => false),
}));

type FakeTUI = TUI & { emitInput(data: string): void };

interface FakeFooter {
  hint: string | null;
  setTransientHint(hint: string | null): void;
  getTransientHint(): string | null;
}

function createFakeFooter(): FooterComponent {
  const footer: FakeFooter = {
    hint: null,
    setTransientHint(hint: string | null): void {
      this.hint = hint;
    },
    getTransientHint(): string | null {
      return this.hint;
    },
  };
  return footer as unknown as FooterComponent;
}

function createFakeTUI(): FakeTUI {
  const listeners = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
  return {
    addInputListener: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    emitInput: (data: string) => {
      for (const listener of listeners) {
        listener(data);
      }
    },
    requestRender: vi.fn(),
  } as unknown as FakeTUI;
}

function createFakeTUIWithConsumingFocusTracker(): FakeTUI {
  const listeners = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
  return {
    addInputListener: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    emitInput: (data: string) => {
      for (const listener of listeners) {
        const result = listener(data);
        if (result?.consume) return;
      }
    },
    requestRender: vi.fn(),
  } as unknown as FakeTUI;
}

// Drive the controller through its first clipboard observation with an empty
// clipboard. The first observation only establishes a baseline and never shows
// a hint, leaving the controller armed and ready for the next new image.
async function primeEmptyBaseline(ui: FakeTUI): Promise<void> {
  vi.mocked(clipboardHasImage).mockResolvedValue(false);
  ui.emitInput(TERMINAL_FOCUS_IN);
  await vi.advanceTimersByTimeAsync(1000);
}

// Simulate the user returning to the terminal and let the debounced check fire.
async function focusReturnAndFlush(ui: FakeTUI): Promise<void> {
  ui.emitInput(TERMINAL_FOCUS_OUT);
  ui.emitInput(TERMINAL_FOCUS_IN);
  await vi.advanceTimersByTimeAsync(1000);
}

describe('ClipboardImageHintController', () => {
  let platformSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(clipboardHasImage).mockResolvedValue(false);
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  });

  afterEach(() => {
    platformSpy?.mockRestore();
    vi.useRealTimers();
  });

  it('does not show a hint for an image already in the clipboard at startup', async () => {
    vi.mocked(clipboardHasImage).mockResolvedValue(true);

    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    // Startup baseline observes the image already present; the focus check
    // runs too but must stay quiet for that same image.
    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);

    // One call is the startup baseline; the second is the focus check.
    expect(clipboardHasImage).toHaveBeenCalledTimes(2);
    expect(footer.getTransientHint()).toBeNull();

    controller.stop();
  });

  it('shows hint when a new image is copied during the session', async () => {
    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    await primeEmptyBaseline(ui);

    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    await focusReturnAndFlush(ui);

    expect(footer.getTransientHint()).toMatch(/Image in clipboard/);
    expect(footer.getTransientHint()).toMatch(/Ctrl\+V/);

    controller.stop();
  });

  it('shows hint for the first image copied after startup when startup baseline was empty', async () => {
    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(clipboardHasImage).toHaveBeenCalledTimes(1);
    expect(footer.getTransientHint()).toBeNull();

    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    await focusReturnAndFlush(ui);

    expect(footer.getTransientHint()).toMatch(/Image in clipboard/);
    expect(footer.getTransientHint()).toMatch(/Ctrl\+V/);

    controller.stop();
  });

  it('does not show hint when model does not support images', async () => {
    vi.mocked(clipboardHasImage).mockResolvedValue(true);

    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => false,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);

    expect(footer.getTransientHint()).toBeNull();

    controller.stop();
  });

  it('does not repeat the hint for the same lingering image', async () => {
    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    // Establish the baseline and show a hint for the first image.
    await primeEmptyBaseline(ui);
    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    await focusReturnAndFlush(ui);
    expect(footer.getTransientHint()).toMatch(/Image in clipboard/);

    // The same image is still in the clipboard: focusing again must not nag.
    vi.mocked(clipboardHasImage).mockClear();
    footer.setTransientHint(null);
    await focusReturnAndFlush(ui);
    expect(footer.getTransientHint()).toBeNull();
    expect(clipboardHasImage).toHaveBeenCalledTimes(1);

    controller.stop();
  });

  it('shows the hint again for a new image after the clipboard is cleared', async () => {
    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    // Establish the baseline, then show a hint for the first image.
    await primeEmptyBaseline(ui);
    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    await focusReturnAndFlush(ui);
    expect(footer.getTransientHint()).toMatch(/Image in clipboard/);

    // Clipboard cleared: the empty check re-arms the controller.
    vi.mocked(clipboardHasImage).mockResolvedValue(false);
    footer.setTransientHint(null);
    await focusReturnAndFlush(ui);
    expect(footer.getTransientHint()).toBeNull();

    // A genuinely new image: hint shows again.
    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    await focusReturnAndFlush(ui);
    expect(footer.getTransientHint()).toMatch(/Image in clipboard/);

    controller.stop();
  });

  it('clears the hint after the display duration', async () => {
    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    await primeEmptyBaseline(ui);
    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    await focusReturnAndFlush(ui);
    expect(footer.getTransientHint()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(4000);
    expect(footer.getTransientHint()).toBeNull();

    controller.stop();
  });

  it('cancels a pending debounced check when focus is lost', async () => {
    vi.mocked(clipboardHasImage).mockResolvedValue(true);

    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(clipboardHasImage).mockClear();

    ui.emitInput(TERMINAL_FOCUS_IN);
    ui.emitInput(TERMINAL_FOCUS_OUT);
    await vi.advanceTimersByTimeAsync(1000);

    expect(clipboardHasImage).not.toHaveBeenCalled();
    expect(footer.getTransientHint()).toBeNull();

    controller.stop();
  });

  it('handles rapid focus churn without duplicate checks or hints', async () => {
    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    await primeEmptyBaseline(ui);
    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    vi.mocked(clipboardHasImage).mockClear();

    for (let i = 0; i < 5; i++) {
      ui.emitInput(TERMINAL_FOCUS_OUT);
      ui.emitInput(TERMINAL_FOCUS_IN);
    }

    await vi.advanceTimersByTimeAsync(1000);

    expect(clipboardHasImage).toHaveBeenCalledTimes(1);
    expect(footer.getTransientHint()).not.toBeNull();

    controller.stop();
  });

  it('ignores stale clipboard read result when focus is lost', async () => {
    vi.mocked(clipboardHasImage).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => { resolve(true); }, 1500)),
    );

    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    // One call is the startup baseline; the second is the debounced focus check.
    expect(clipboardHasImage).toHaveBeenCalledTimes(2);

    ui.emitInput(TERMINAL_FOCUS_OUT);
    await vi.advanceTimersByTimeAsync(1500);
    expect(footer.getTransientHint()).toBeNull();

    controller.stop();
  });

  it('ignores a pending clipboard read result after stop', async () => {
    let resolveDeferred: (value: boolean) => void = () => {};
    vi.mocked(clipboardHasImage).mockImplementation(
      () => new Promise<boolean>((resolve) => {
        resolveDeferred = resolve;
      }),
    );

    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    // One call is the startup baseline; the second is the debounced focus check.
    expect(clipboardHasImage).toHaveBeenCalledTimes(2);

    controller.stop();
    resolveDeferred(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(footer.getTransientHint()).toBeNull();
  });

  it('clears a displayed hint when stopped', async () => {
    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    await primeEmptyBaseline(ui);
    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    await focusReturnAndFlush(ui);
    expect(footer.getTransientHint()).not.toBeNull();

    controller.stop();
    expect(footer.getTransientHint()).toBeNull();
    expect(host.requestRender).toHaveBeenCalled();
  });

  it('does not clear a hint set by another caller when stopped', async () => {
    vi.mocked(clipboardHasImage).mockResolvedValue(true);

    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const requestRender = vi.fn();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender,
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    // First observation only establishes the baseline and sets no hint.
    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    const otherHint = 'Other hint';
    footer.setTransientHint(otherHint);

    const requestRenderCalls = requestRender.mock.calls.length;
    controller.stop();
    expect(footer.getTransientHint()).toBe(otherHint);
    expect(host.requestRender).toHaveBeenCalledTimes(requestRenderCalls);
  });

  it('uses only the latest clipboard read result after focus churn', async () => {
    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    // Establish an empty baseline with a normal resolved read first.
    await primeEmptyBaseline(ui);

    const deferreds: Array<{ resolve: (value: boolean) => void; promise: Promise<boolean> }> = [];
    vi.mocked(clipboardHasImage).mockImplementation(() => {
      let resolve: (value: boolean) => void = () => {};
      const promise = new Promise<boolean>((res) => {
        resolve = res;
      });
      deferreds.push({ resolve, promise });
      return promise;
    });

    ui.emitInput(TERMINAL_FOCUS_OUT);
    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deferreds).toHaveLength(1);

    ui.emitInput(TERMINAL_FOCUS_OUT);
    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(deferreds).toHaveLength(2);

    deferreds[0]!.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(footer.getTransientHint()).toBeNull();

    deferreds[1]!.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(footer.getTransientHint()).toMatch(/Image in clipboard/);

    controller.stop();
  });

  it('keeps the existing auto-clear timer when a re-check exits early', async () => {
    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    await primeEmptyBaseline(ui);
    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    await focusReturnAndFlush(ui);
    expect(footer.getTransientHint()).not.toBeNull();

    // Trigger a re-check that exits early because the clipboard is now empty.
    vi.mocked(clipboardHasImage).mockResolvedValue(false);
    await focusReturnAndFlush(ui);

    // The previous hint should still be visible because its auto-clear timer
    // was preserved through the re-check.
    expect(footer.getTransientHint()).not.toBeNull();

    // Advance the remaining original display duration and verify it expires.
    await vi.advanceTimersByTimeAsync(3000);
    expect(footer.getTransientHint()).toBeNull();

    controller.stop();
  });

  it('does not clear a matching hint owned by another caller after auto-clear', async () => {
    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    await primeEmptyBaseline(ui);
    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    await focusReturnAndFlush(ui);
    const hintText = footer.getTransientHint();
    expect(hintText).not.toBeNull();

    await vi.advanceTimersByTimeAsync(4000);
    expect(footer.getTransientHint()).toBeNull();

    // Another caller sets the same hint text the controller previously used.
    footer.setTransientHint(hintText);

    controller.stop();
    expect(footer.getTransientHint()).toBe(hintText);
  });

  it('re-establishes the baseline after stop and restart', async () => {
    vi.mocked(clipboardHasImage).mockResolvedValue(true);

    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    // Image already present at start: baseline only, no hint.
    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(footer.getTransientHint()).toBeNull();

    controller.stop();
    controller.start();

    // After restart the image is still present: baseline again, no hint.
    await focusReturnAndFlush(ui);
    expect(footer.getTransientHint()).toBeNull();

    // Clipboard cleared: re-arms the controller.
    vi.mocked(clipboardHasImage).mockResolvedValue(false);
    await focusReturnAndFlush(ui);
    expect(footer.getTransientHint()).toBeNull();

    // A genuinely new image: hint shows.
    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    await focusReturnAndFlush(ui);
    expect(footer.getTransientHint()).toMatch(/Image in clipboard/);

    controller.stop();
  });

  it('observes focus events even when another listener consumes them', async () => {
    const footer = createFakeFooter();
    const ui = createFakeTUIWithConsumingFocusTracker();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    // Register a second listener that consumes focus events, like installTerminalFocusTracking.
    const consumedEvents: string[] = [];
    ui.addInputListener((data) => {
      if (data === TERMINAL_FOCUS_IN || data === TERMINAL_FOCUS_OUT) {
        consumedEvents.push(data);
        return { consume: true };
      }
      return undefined;
    });

    // Baseline observation (consumed), then a new image on the next focus.
    vi.mocked(clipboardHasImage).mockResolvedValue(false);
    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);

    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    ui.emitInput(TERMINAL_FOCUS_OUT);
    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);

    expect(consumedEvents).toEqual([TERMINAL_FOCUS_IN, TERMINAL_FOCUS_OUT, TERMINAL_FOCUS_IN]);
    expect(footer.getTransientHint()).toMatch(/Image in clipboard/);

    controller.stop();
  });

  it('shows Alt+V shortcut on Windows', async () => {
    platformSpy?.mockRestore();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const footer = createFakeFooter();
    const ui = createFakeTUI();
    const host: ClipboardImageHintHost = {
      ui,
      footer,
      getModelSupportsImage: () => true,
      requestRender: vi.fn(),
    };

    const controller = new ClipboardImageHintController(host);
    controller.start();

    await primeEmptyBaseline(ui);
    vi.mocked(clipboardHasImage).mockResolvedValue(true);
    await focusReturnAndFlush(ui);

    expect(footer.getTransientHint()).toMatch(/Alt\+V/);

    controller.stop();
  });
});
