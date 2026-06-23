import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClipboardImageHintController,
  type ClipboardImageHintHost,
} from '#/tui/controllers/clipboard-image-hint';
import type { FooterComponent } from '#/tui/components/chrome/footer';
import { TERMINAL_FOCUS_IN, TERMINAL_FOCUS_OUT } from '#/tui/utils/terminal-focus';
import type { TUI } from '@earendil-works/pi-tui';

vi.mock('#/utils/clipboard/clipboard-has-image', () => ({
  clipboardHasImage: vi.fn(async () => false),
}));

import { clipboardHasImage } from '#/utils/clipboard/clipboard-has-image';

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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(clipboardHasImage).mockResolvedValue(false);
  });

  afterEach(() => {
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
});
