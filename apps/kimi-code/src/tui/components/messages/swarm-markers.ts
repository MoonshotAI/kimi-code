import type { Component } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

export class SwarmModeMarkerComponent implements Component {
  constructor(
    private readonly active: boolean,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {}

  render(_width: number): string[] {
    const color = this.active ? this.colors.primary : this.colors.textDim;
    const marker = chalk.hex(color).bold(STATUS_BULLET);
    const label = chalk.hex(color).bold(this.active ? 'Swarm activated' : 'Swarm deactivated');
    return ['', marker + label];
  }
}
