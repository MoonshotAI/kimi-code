/**
 * Container that reserves left/right gutter columns around its children,
 * so the chrome (statusline, transcript, panels) lines up with the input
 * box's inner content area instead of butting up against the terminal edge.
 *
 * Children are rendered at `width - left - right` and each emitted line is
 * prefixed with `left` plain spaces. Right padding is logical only — we
 * never emit trailing spaces, since terminals already paint background to
 * the edge and adding them would just churn the diff renderer.
 */

import { Container } from '@earendil-works/pi-tui';

export class GutterContainer extends Container {
  constructor(
    private readonly leftPad: number,
    private readonly rightPad: number,
  ) {
    super();
  }

  override render(width: number): string[] {
    // If the terminal is narrower than the gutters themselves, skip content
    // rather than clamping the inner width to 1 and producing an over-wide line.
    if (width < this.leftPad + this.rightPad) {
      return [''];
    }
    const inner = width - this.leftPad - this.rightPad;
    const lead = ' '.repeat(this.leftPad);
    const out: string[] = [];
    for (const child of this.children) {
      for (const line of child.render(inner)) {
        out.push(lead + line);
      }
    }
    return out;
  }
}
