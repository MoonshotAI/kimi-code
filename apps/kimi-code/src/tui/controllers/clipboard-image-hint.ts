import type { TUI } from '@earendil-works/pi-tui';

import { clipboardHasImage } from '#/utils/clipboard/clipboard-has-image';

import { TERMINAL_FOCUS_IN, TERMINAL_FOCUS_OUT } from '../utils/terminal-focus';
import type { FooterComponent } from '../components/chrome/footer';

const FOCUS_DEBOUNCE_MS = 1_000;
const HINT_COOLDOWN_MS = 30_000;
const HINT_DISPLAY_MS = 2_000;

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
  private lastHintAtMs = 0;
  private focused = true;

  constructor(host: ClipboardImageHintHost) {
    this.host = host;
  }

  start(): void {
    this.disposeInputListener = this.host.ui.addInputListener((data) => this.handleInput(data));
  }

  stop(): void {
    this.clearTimers();
    this.disposeInputListener?.();
    this.disposeInputListener = undefined;
  }

  private handleInput(data: string): { consume: true } | undefined {
    if (data === TERMINAL_FOCUS_IN) {
      this.focused = true;
      this.scheduleCheck();
      return { consume: true };
    }
    if (data === TERMINAL_FOCUS_OUT) {
      this.focused = false;
      this.clearTimers();
      return { consume: true };
    }
    return undefined;
  }

  private scheduleCheck(): void {
    this.clearTimers();
    this.debounceTimer = setTimeout(() => void this.runCheck(), FOCUS_DEBOUNCE_MS);
  }

  private clearTimers(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.clearHintTimer !== undefined) {
      clearTimeout(this.clearHintTimer);
      this.clearHintTimer = undefined;
    }
  }

  private async runCheck(): Promise<void> {
    if (!this.focused) return;
    if (!this.host.getModelSupportsImage()) return;
    if (Date.now() - this.lastHintAtMs < HINT_COOLDOWN_MS) return;

    let hasImage = false;
    try {
      hasImage = await clipboardHasImage();
    } catch {
      return;
    }

    if (!hasImage) return;

    const hintText = `Image in clipboard · ${getPasteImageShortcut()} to paste`;
    this.host.footer.setTransientHint(hintText);
    this.host.requestRender();
    this.lastHintAtMs = Date.now();

    this.clearHintTimer = setTimeout(() => {
      if (this.host.footer.getTransientHint() === hintText) {
        this.host.footer.setTransientHint(null);
        this.host.requestRender();
      }
    }, HINT_DISPLAY_MS);
  }
}
