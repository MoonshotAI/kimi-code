import { truncateToWidth, type Component } from '@earendil-works/pi-tui';

import { currentTheme } from '#/tui/theme';

export class ReviewStatusComponent implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    const status = `${currentTheme.boldFg('primary', '●')} ${currentTheme.boldFg('primary', 'Reviewing...')}`;
    return ['', truncateToWidth(status, width)];
  }
}
