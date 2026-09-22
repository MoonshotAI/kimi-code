/**
 * Session tab labels shared by the tab strip and the `/tab list` output.
 */

import { truncateToWidth } from '@moonshot-ai/pi-tui';

import type { SessionTabStatus } from '#/tui/controllers/session-tabs';

export interface SessionTabView {
  readonly sessionId: string;
  readonly title: string | null;
  readonly status: SessionTabStatus;
  readonly unread: boolean;
}

const MAX_TITLE_WIDTH = 24;
const UNREAD_MARK = '•';

const STATUS_GLYPH: Record<SessionTabStatus, string> = {
  idle: '',
  running: '●',
  waiting: '⏸',
  done: '✓',
  error: '!',
};

export function sessionTabTitle(view: Pick<SessionTabView, 'sessionId' | 'title'>): string {
  const title = view.title?.replaceAll(/\s+/g, ' ').trim() ?? '';
  return title.length > 0 ? title : view.sessionId.slice(0, 8);
}

/** `1● Fix the parser •` — index for Alt+<n>, state glyph, title, unread marker. */
export function formatSessionTabLabel(index: number, view: SessionTabView): string {
  const glyph = STATUS_GLYPH[view.status];
  const title = truncateToWidth(sessionTabTitle(view), MAX_TITLE_WIDTH, '…');
  const unread = view.unread ? ` ${UNREAD_MARK}` : '';
  return `${String(index + 1)}${glyph} ${title}${unread}`;
}
