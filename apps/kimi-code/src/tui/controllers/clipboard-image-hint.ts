import type { TUI } from '@moonshot-ai/pi-tui';

import { clipboardHasImage } from '#/utils/clipboard/clipboard-has-image';

import { FOCUS_DEBOUNCE_MS, HINT_DISPLAY_MS } from '../constant/clipboard-image-hint';
import { TERMINAL_FOCUS_IN, TERMINAL_FOCUS_OUT } from '../utils/terminal-focus';
import type { FooterComponent } from '../components/chrome/footer';

export interface ClipboardImageHintHost {
  readonly ui: TUI;
  readonly footer: FooterComponent;
  getModelSupportsImage(): boolean;
  requestRender(): void;
}

function getPasteImageShortcut(): string {
  return process.platform === 'win32' ? 'Alt+V' : 'Ctrl+V';
}

export class ClipboardImageHintController {
  private readonly host: ClipboardImageHintHost;
  private disposeInputListener: (() => void) | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private clearHintTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHintText: string | undefined;
  private checkGeneration = 0;
  private focused = true;
  private initialized = false;
  private armed = true;

  constructor(host: ClipboardImageHintHost) {
    this.host = host;
  }

  start(): void {
    this.disposeInputListener = this.host.ui.addInputListener((data) => {
      this.handleInput(data);
    });
    void this.establishInitialBaseline();
  }

  stop(): void {
    this.clearDebounceTimer();
    this.clearClearHintTimer();
    this.disposeInputListener?.();
    this.disposeInputListener = undefined;

    this.checkGeneration += 1;
    this.clearOwnedHint();
    this.initialized = false;
    this.armed = true;
  }

  private handleInput(data: string): void {
    if (data === TERMINAL_FOCUS_IN) {
      this.focused = true;
      this.scheduleCheck();
      return;
    }
    if (data === TERMINAL_FOCUS_OUT) {
      this.focused = false;
      this.clearDebounceTimer();
      return;
    }
  }

  private scheduleCheck(): void {
    this.clearDebounceTimer();
    this.checkGeneration += 1;
    const generation = this.checkGeneration;
    this.debounceTimer = setTimeout(() => void this.runCheck(generation), FOCUS_DEBOUNCE_MS);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  private clearClearHintTimer(): void {
    if (this.clearHintTimer !== undefined) {
      clearTimeout(this.clearHintTimer);
      this.clearHintTimer = undefined;
    }
  }

  private clearOwnedHint(): void {
    if (this.host.footer.getTransientHint() === this.lastHintText) {
      this.host.footer.setTransientHint(null);
      this.host.requestRender();
    }
    this.lastHintText = undefined;
  }

  private async establishInitialBaseline(): Promise<void> {
    if (!this.host.getModelSupportsImage()) return;

    this.checkGeneration += 1;
    const generation = this.checkGeneration;

    let hasImage = false;
    try {
      hasImage = await clipboardHasImage();
    } catch {
      return;
    }

    if (generation !== this.checkGeneration) return;

    this.initialized = true;
    this.armed = !hasImage;
  }

  private async runCheck(generation: number): Promise<void> {
    if (!this.focused) return;
    if (!this.host.getModelSupportsImage()) return;

    let hasImage = false;
    try {
      hasImage = await clipboardHasImage();
    } catch {
      return;
    }

    if (generation !== this.checkGeneration) return;
    if (!this.focused) return;

    if (!this.initialized) {
      this.initialized = true;
      this.armed = !hasImage;
      return;
    }

    if (!hasImage) {
      this.armed = true;
      return;
    }

    if (!this.armed) return;

    const hintText = `Image in clipboard · ${getPasteImageShortcut()} to paste`;
    this.clearClearHintTimer();
    this.lastHintText = hintText;
    this.armed = false;
    this.host.footer.setTransientHint(hintText);
    this.host.requestRender();

    this.clearHintTimer = setTimeout(() => {
      this.clearOwnedHint();
    }, HINT_DISPLAY_MS);
  }
}
