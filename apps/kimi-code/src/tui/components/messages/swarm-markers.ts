import type { Component } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

export type SwarmModeMarkerState = 'active' | 'inactive' | 'ended';

export class SwarmModeMarkerComponent implements Component {
  constructor(
    private readonly state: SwarmModeMarkerState,
    private readonly colors: ColorPalette,
  ) {}

  invalidate(): void {}

  render(_width: number): string[] {
    const color = this.state === 'inactive' ? this.colors.textDim : this.colors.success;
    const marker = chalk.hex(color).bold(STATUS_BULLET);
    const label = chalk.hex(color).bold(swarmMarkerLabel(this.state));
    return ['', marker + label];
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
