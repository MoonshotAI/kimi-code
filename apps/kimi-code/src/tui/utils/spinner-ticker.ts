import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
} from '#/tui/constant/rendering';

export class SpinnerTicker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  constructor(private readonly onTick: () => void) {}

  get current(): string {
    return BRAILLE_SPINNER_FRAMES[this.frame] ?? BRAILLE_SPINNER_FRAMES[0]!;
  }

  start(): void {
    if (this.timer !== null) return;
    this.frame = 0;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.onTick();
    }, BRAILLE_SPINNER_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.frame = 0;
  }

  dispose(): void {
    this.stop();
  }
}
