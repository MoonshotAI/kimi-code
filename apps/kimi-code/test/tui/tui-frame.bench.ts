/**
 * Benchmark for the TUI steady-state frame (Phase: doRender fast path).
 *
 * Measures the cost of one frame over a very long transcript when only a
 * single line changed — the shape every spinner tick and streaming flush
 * produces. Component render caches return the same string references for
 * unchanged content, so doRender's processed-line reuse turns the frame into
 * O(total lines) pointer comparisons plus O(changed lines) real work. A
 * regression here re-introduces the per-frame full-transcript processing that
 * pegged CPU in long sessions.
 *
 * Run:
 *   pnpm --filter @moonshot-ai/kimi-code exec vitest bench test/tui/tui-frame.bench.ts
 */

import type { Component, Terminal } from '@moonshot-ai/pi-tui';
import { TUI } from '@moonshot-ai/pi-tui';
import { bench, describe } from 'vitest';

const WIDTH = 120;
const HEIGHT = 40;
const TRANSCRIPT_LINES = 30_000;

/** Terminal stub that discards output — we benchmark frame computation, not xterm parsing. */
class StubTerminal implements Terminal {
  /**
   * Counts writes so the frame's output is an observable side effect; an
   * empty write would let the JIT eliminate the whole frame as dead code.
   */
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
}

/** Returns the same array reference every frame, mirroring the app's cached message components. */
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
  const tui = new TUI(terminal);
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

  // doRender is private; the bench drives it directly so the measurement is
  // one frame's computation without the 16ms render throttle in between.
  const renderFrame = (): void => {
    spinner.frame++;
    (tui as unknown as { doRender(): void }).doRender();
  };
  renderFrame();

  // No teardown/stop here: bench-option hooks fire per measured iteration,
  // and stopping the TUI would turn every subsequent frame into a no-op.
  bench(`${TRANSCRIPT_LINES}-line transcript, one spinner line change per frame`, () => {
    renderFrame();
  });
});
