import type { Component, Terminal } from '@moonshot-ai/pi-tui';
import { TuiMainScreen } from '@moonshot-ai/pi-tui';
import { bench, describe } from 'vitest';

const WIDTH = 120;
const HEIGHT = 40;
const TRANSCRIPT_LINES = 30_000;

class StubTerminal implements Terminal {
  writes = 0;
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {
    this.writes++;
  }
  get columns(): number {
    return WIDTH;
  }
  get rows(): number {
    return HEIGHT;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}

class StaticTranscript implements Component {
  constructor(private readonly lines: string[]) {}
  render(): string[] {
    return this.lines;
  }
  invalidate(): void {}
}

class SpinnerComponent implements Component {
  frame = 0;
  render(): string[] {
    return [`⠋ working (frame ${this.frame})`];
  }
  invalidate(): void {}
}

describe('TUI steady-state frame', () => {
  const terminal = new StubTerminal();
  const tui = new TuiMainScreen(terminal);
  const spinner = new SpinnerComponent();
  tui.addChild(
    new StaticTranscript(
      Array.from(
        { length: TRANSCRIPT_LINES },
        (_, i) => `transcript line ${i} — the quick brown fox jumps over the lazy dog`,
      ),
    ),
  );
  tui.addChild(spinner);
  tui.start();

  const renderFrame = (): void => {
    spinner.frame++;
    (tui as unknown as { doRender(): void }).doRender();
  };
  renderFrame();

  bench(`${TRANSCRIPT_LINES}-line transcript, one spinner line change per frame`, () => {
    renderFrame();
  });
});
