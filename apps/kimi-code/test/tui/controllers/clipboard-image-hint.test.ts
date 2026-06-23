import type { TUI } from '@earendil-works/pi-tui';
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
        const result = listener(data);
        if (result?.consume) return;
      }
    },
    requestRender: vi.fn(),
  } as unknown as FakeTUI;
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

  it('shows hint when focus returns and clipboard has image', async () => {
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

    ui.emitInput(TERMINAL_FOCUS_OUT);
    ui.emitInput(TERMINAL_FOCUS_IN);

    await vi.advanceTimersByTimeAsync(1000);

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

  it('respects cooldown between hints', async () => {
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

    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(footer.getTransientHint()).not.toBeNull();

    footer.setTransientHint(null);
    ui.emitInput(TERMINAL_FOCUS_OUT);
    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(footer.getTransientHint()).toBeNull();

    controller.stop();
  });

  it('clears hint after 2 seconds', async () => {
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

    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(footer.getTransientHint()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2000);
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

    ui.emitInput(TERMINAL_FOCUS_IN);
    ui.emitInput(TERMINAL_FOCUS_OUT);
    await vi.advanceTimersByTimeAsync(1000);

    expect(clipboardHasImage).not.toHaveBeenCalled();
    expect(footer.getTransientHint()).toBeNull();

    controller.stop();
  });

  it('handles rapid focus churn without duplicate checks or hints', async () => {
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
    expect(clipboardHasImage).toHaveBeenCalledTimes(1);

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
    expect(clipboardHasImage).toHaveBeenCalledTimes(1);

    controller.stop();
    resolveDeferred(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(footer.getTransientHint()).toBeNull();
  });

  it('clears a displayed hint when stopped', async () => {
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

    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
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
    const deferreds: Array<{ resolve: (value: boolean) => void; promise: Promise<boolean> }> = [];
    vi.mocked(clipboardHasImage).mockImplementation(() => {
      let resolve: (value: boolean) => void = () => {};
      const promise = new Promise<boolean>((res) => {
        resolve = res;
      });
      deferreds.push({ resolve, promise });
      return promise;
    });

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
    expect(clipboardHasImage).toHaveBeenCalledTimes(1);

    ui.emitInput(TERMINAL_FOCUS_OUT);
    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clipboardHasImage).toHaveBeenCalledTimes(2);

    deferreds[0]!.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(footer.getTransientHint()).toBeNull();

    deferreds[1]!.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(footer.getTransientHint()).toMatch(/Image in clipboard/);

    controller.stop();
  });

  it('keeps the existing auto-clear timer when a re-check exits early', async () => {
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

    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(footer.getTransientHint()).not.toBeNull();

    // Trigger a re-check that exits early because the clipboard is now empty.
    vi.mocked(clipboardHasImage).mockResolvedValue(false);
    ui.emitInput(TERMINAL_FOCUS_OUT);
    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);

    // The previous hint should still be visible because its auto-clear timer
    // was preserved through the re-check.
    expect(footer.getTransientHint()).not.toBeNull();

    // Advance the remaining original display duration and verify it expires.
    await vi.advanceTimersByTimeAsync(1000);
    expect(footer.getTransientHint()).toBeNull();

    controller.stop();
  });

  it('does not clear a matching hint owned by another caller after auto-clear', async () => {
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

    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    const hintText = footer.getTransientHint();
    expect(hintText).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2000);
    expect(footer.getTransientHint()).toBeNull();

    // Another caller sets the same hint text the controller previously used.
    footer.setTransientHint(hintText);

    controller.stop();
    expect(footer.getTransientHint()).toBe(hintText);
  });

  it('does not inherit cooldown after stop and restart', async () => {
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

    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);
    expect(footer.getTransientHint()).not.toBeNull();

    controller.stop();
    controller.start();

    footer.setTransientHint(null);
    ui.emitInput(TERMINAL_FOCUS_OUT);
    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);

    expect(footer.getTransientHint()).not.toBeNull();

    controller.stop();
  });

  it('shows Alt+V shortcut on Windows', async () => {
    platformSpy?.mockRestore();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
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

    ui.emitInput(TERMINAL_FOCUS_IN);
    await vi.advanceTimersByTimeAsync(1000);

    expect(footer.getTransientHint()).toMatch(/Alt\+V/);

    controller.stop();
  });
});
