import { Text, visibleWidth } from '@moonshot-ai/pi-tui';
import type { TUI } from '@moonshot-ai/pi-tui';

import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  MOON_SPINNER_FRAMES,
  MOON_SPINNER_INTERVAL_MS,
} from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';

export type SpinnerStyle = 'moon' | 'braille';

export class MoonLoader extends Text {
  private currentFrame = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private ui: TUI;
  private frames: string[];
  private interval: number;
  private colorFn?: (s: string) => string;
  private label: string;
  private displayText = '';
  // Inline text used when the spinner is embedded into another line (e.g. the
  // agent-swarm progress status line). It intentionally excludes the tip: the
  // tip is only rendered when the loader sits on its own row in the activity
  // pane, otherwise it would get squeezed against whatever follows the inline
  // spinner (like the swarm progress bar).
  private inlineText = '';
  private tip: string = '';
  private availableWidth = 0;

  constructor(
    ui: TUI,
    style: SpinnerStyle = 'moon',
    colorFn?: (s: string) => string,
    label: string = '',
  ) {
    super('', 1, 0);
    this.ui = ui;
    this.frames = style === 'moon' ? [...MOON_SPINNER_FRAMES] : [...BRAILLE_SPINNER_FRAMES];
    this.interval = style === 'moon' ? MOON_SPINNER_INTERVAL_MS : BRAILLE_SPINNER_INTERVAL_MS;
    this.colorFn = colorFn;
    this.label = label;
    this.start();
  }

  start(): void {
    this.updateDisplay();
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      this.updateDisplay();
    }, this.interval);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  dispose(): void {
    this.stop();
  }

  setLabel(label: string): void {
    this.label = label;
    this.updateDisplay();
  }

  setColorFn(colorFn: (s: string) => string): void {
    this.colorFn = colorFn;
    this.updateDisplay();
  }

  setTip(tip: string): void {
    this.tip = tip;
    this.updateDisplay();
  }

  setAvailableWidth(width: number): void {
    if (this.availableWidth === width) return;
    this.availableWidth = width;
    this.updateDisplay();
  }

  renderInline(): string {
    return this.inlineText;
  }

  private updateDisplay(): void {
    const frame = this.frames[this.currentFrame]!;
    const coloredFrame = this.colorFn ? this.colorFn(frame) : frame;
    const baseText = this.label ? `${coloredFrame} ${this.label}` : coloredFrame;
    this.inlineText = baseText;
    let text = baseText;
    if (this.tip) {
      const withTip = baseText + currentTheme.fg('textDim', this.tip);
      if (this.availableWidth === 0 || visibleWidth(withTip) <= this.availableWidth) {
        text = withTip;
      }
    }
    this.displayText = text;
    this.setText(this.displayText);
    this.ui.requestRender();
  }
}
