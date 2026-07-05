import type { Component } from '@moonshot-ai/pi-tui';

export interface FixedHeightWindowOptions {
  height: number;
  lines?: string[];
  tail?: boolean; // default true
}

export class FixedHeightWindow implements Component {
  private lines: string[];
  private readonly height: number;
  private readonly tail: boolean;

  constructor(opts: FixedHeightWindowOptions) {
    this.height = Math.max(0, opts.height);
    this.tail = opts.tail ?? true;
    this.lines = opts.lines ?? [];
  }

  setLines(lines: string[]): void {
    this.lines = lines;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    if (this.height === 0) return [];
    const src = this.lines;
    let shown: string[];
    if (src.length > this.height) {
      shown = this.tail ? src.slice(src.length - this.height) : src.slice(0, this.height);
    } else {
      shown = [...src];
    }
    while (shown.length < this.height) shown.push('');
    return shown;
  }
}
