/**
 * SessionTabStrip — one-line strip listing the sessions hosted as tabs.
 *
 * Mounted in its own chrome slot between the editor and the footer. It renders nothing
 * while fewer than two tabs exist, so a single-session TUI looks exactly as
 * it does without tabs. Each cell reads `<n><state> <title>` with an unread
 * marker when a background tab produced output since it was last viewed;
 * the strip itself reuses the shared tab renderer (scrolls to keep the
 * active tab visible). See .agents/skills/write-tui/DESIGN.md §5.
 */

import type { Component } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { formatSessionTabLabel, type SessionTabView } from '#/tui/utils/session-tab-label';
import { renderTabStrip } from '#/tui/utils/tab-strip';

export { formatSessionTabLabel, sessionTabTitle, type SessionTabView } from '#/tui/utils/session-tab-label';

export class SessionTabStripComponent implements Component {
  private views: readonly SessionTabView[] = [];
  private activeIndex = -1;

  /** Replace the strip contents; returns whether anything visible changed. */
  setTabs(views: readonly SessionTabView[], activeIndex: number): boolean {
    const before = this.key();
    this.views = views.map((view) => ({ ...view }));
    this.activeIndex = activeIndex;
    return this.key() !== before;
  }

  isVisible(): boolean {
    return this.views.length > 1;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.isVisible()) return [];
    const labels = this.views.map((view, index) => formatSessionTabLabel(index, view));
    return [
      renderTabStrip({
        labels,
        activeIndex: Math.max(0, this.activeIndex),
        width,
        colors: currentTheme.palette,
      }),
    ];
  }

  private key(): string {
    return `${String(this.activeIndex)}|${this.views
      .map((view) => `${view.sessionId}:${view.title ?? ''}:${view.status}:${String(view.unread)}`)
      .join('|')}`;
  }
}
