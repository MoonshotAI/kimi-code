import type { Component, NativeScrollbackLiveRegion } from '@moonshot-ai/pi-tui';

import { isTurnBoundaryComponent } from '#/tui/utils/transcript-component-metadata';

import { GutterContainer } from './gutter-container';

/**
 * Transcript container that reports the native-scrollback live-region seam to
 * the ledger engine. The live region starts at the beginning of the current
 * (last) turn: everything before that row is byte-stable committed history,
 * everything from that row onward is live and may change between renders.
 */
export class TranscriptContainer extends GutterContainer implements NativeScrollbackLiveRegion {
  private liveRegionStart: number | undefined;

  getNativeScrollbackLiveRegionStart(): number | undefined {
    return this.liveRegionStart;
  }

  protected override onChildRendered(child: Component, startRow: number, _lineCount: number): void {
    if (isTurnBoundaryComponent(child)) {
      // Last boundary wins — the live region starts at the current (last) turn.
      this.liveRegionStart = startRow;
    }
  }

  override render(width: number): string[] {
    this.liveRegionStart = undefined;
    return super.render(width);
  }
}
