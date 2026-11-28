import {
  textRenderLine,
  truncateRenderLine,
  truncateToWidth,
  type Component,
} from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

import type { TranscriptRowParts } from './transcript-row-layout';

export type SwarmModeMarkerState = 'active' | 'inactive' | 'ended';

export class SwarmModeMarkerComponent implements Component {
  constructor(private readonly state: SwarmModeMarkerState) {}

  invalidate(): void {}

  renderTranscriptRow(width: number): TranscriptRowParts {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= STATUS_BULLET.length) {
      const gutterLines = this.render(safeWidth).map((line) => textRenderLine(line));
      return {
        gutterWidth: safeWidth,
        gutterLines,
        contentLines: gutterLines.map(() => textRenderLine('')),
      };
    }

    const token = this.state === 'inactive' ? 'textDim' : 'success';
    const marker = currentTheme.boldFg(token, STATUS_BULLET);
    const label = currentTheme.boldFg(token, swarmMarkerLabel(this.state));
    return {
      gutterWidth: STATUS_BULLET.length,
      gutterLines: [textRenderLine(''), textRenderLine(marker)],
      contentLines: [
        textRenderLine(''),
        truncateRenderLine(textRenderLine(label), safeWidth - STATUS_BULLET.length, '…'),
      ],
    };
  }

  selectionExclusions() {
    return [{ start: 0, end: STATUS_BULLET.length }];
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const token = this.state === 'inactive' ? 'textDim' : 'success';
    const marker = currentTheme.boldFg(token, STATUS_BULLET);
    const label = currentTheme.boldFg(token, swarmMarkerLabel(this.state));
    return ['', truncateToWidth(marker + label, safeWidth, '…')];
  }
}

function swarmMarkerLabel(state: SwarmModeMarkerState): string {
  switch (state) {
    case 'active':
      return 'Swarm activated';
    case 'inactive':
      return 'Swarm deactivated';
    case 'ended':
      return 'Swarm ended';
  }
}
