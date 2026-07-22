/**
 * DiffViewer — full-screen diff viewer used by the `/diff` file picker.
 *
 * Displays a previously computed diff panel and allows the user to press Esc
 * to return to the file list, or ctrl+o to toggle expanded context.
 */

import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import { Key, matchesKey, truncateToWidth } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { formatErrorMessage } from '#/tui/utils/event-payload';
import { DiffPanelComponent } from '../messages/diff-panel';

const TITLE = 'Diff viewer — Esc to return to file list';
const FOOTER_EXPAND = 'ctrl+o expand context · Esc to return to file list';
const FOOTER_COLLAPSE = 'ctrl+o collapse context · Esc to return to file list';
const FOOTER = 'Press Esc to return to file list';

export interface DiffViewerOptions {
  readonly initialLines?: readonly string[];
  readonly onBack: () => void;
  /**
   * If provided, pressing ctrl+o toggles expanded context. The callback
   * receives the desired expanded state and should return the matching diff
   * lines.
   */
  readonly onToggleExpand?: (
    expanded: boolean,
  ) => Promise<readonly string[]> | readonly string[];
  /**
   * Called after async expansion finishes so the host can request a render.
   * Without this, expanded/collapsed content may not appear until the next
   * input event.
   */
  readonly requestRender?: () => void;
}

export class DiffViewerComponent implements Component, Focusable {
  focused = false;
  private readonly panel: DiffPanelComponent;
  private lines: readonly string[];
  private expanded = false;
  private toggling = false;

  constructor(private readonly opts: DiffViewerOptions) {
    this.lines = opts.initialLines ?? [currentTheme.fg('textDim', 'Loading diff...')];
    this.panel = new DiffPanelComponent(() => this.lines);
  }

  setLines(lines: readonly string[]): void {
    this.lines = lines;
    this.panel.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onBack();
      return;
    }

    if (matchesKey(data, Key.ctrl('o')) && this.opts.onToggleExpand && !this.toggling) {
      this.toggling = true;
      const nextExpanded = !this.expanded;
      void Promise.resolve(this.opts.onToggleExpand(nextExpanded))
        .then((lines) => {
          this.expanded = nextExpanded;
          this.setLines(lines);
          this.opts.requestRender?.();
        })
        .catch((error: unknown) => {
          this.setLines([
            currentTheme.fg('diffRemoved', `Failed to load expanded diff: ${formatErrorMessage(error)}`),
          ]);
          this.opts.requestRender?.();
        })
        .finally(() => {
          this.toggling = false;
        });
    }
  }

  render(width: number): string[] {
    const title = truncateToWidth(currentTheme.fg('textDim', TITLE), Math.max(1, width));
    let footerText = FOOTER;
    if (this.opts.onToggleExpand) {
      footerText = this.expanded ? FOOTER_COLLAPSE : FOOTER_EXPAND;
    }
    const footer = truncateToWidth(currentTheme.fg('textDim', footerText), Math.max(1, width));
    const panelLines = this.panel.render(width);
    return [title, ...panelLines, '', footer];
  }

  invalidate(): void {
    this.panel.invalidate();
  }
}
