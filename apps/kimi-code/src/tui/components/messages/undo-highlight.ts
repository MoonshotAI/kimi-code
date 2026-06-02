import type { Component } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

const HIGHLIGHT_MARK = '┃ ';
const ELLIPSIS = '…';

interface UndoHighlightOptions {
  readonly extendBottom?: boolean;
  readonly maxLines?: number;
}

export class UndoHighlightComponent implements Component {
  private readonly childComponents: readonly Component[];
  private readonly extendBottom: boolean;
  private readonly maxLines: number | undefined;

  constructor(
    children: Component | readonly Component[],
    private readonly colors: ColorPalette,
    options: UndoHighlightOptions = {},
  ) {
    this.childComponents = Array.isArray(children) ? children : [children];
    this.extendBottom = options.extendBottom ?? false;
    this.maxLines = options.maxLines;
  }

  invalidate(): void {
    for (const child of this.childComponents) {
      child.invalidate?.();
    }
  }

  render(width: number): string[] {
    const mark = chalk.hex(this.colors.undoHighlight).bold(HIGHLIGHT_MARK);
    const markWidth = visibleWidth(mark);
    const childWidth = Math.max(1, width - markWidth);
    let childLines = this.childComponents.flatMap((child) => child.render(childWidth));
    const maxLines = this.maxLines;
    if (maxLines !== undefined && childLines.length > maxLines) {
      childLines = [
        ...childLines.slice(0, maxLines),
        chalk.hex(this.colors.undoHighlight)(ELLIPSIS),
      ];
    }
    const lines = childLines.map((line) => mark + line);
    if (this.extendBottom) {
      lines.push(mark);
    }
    return lines;
  }
}
