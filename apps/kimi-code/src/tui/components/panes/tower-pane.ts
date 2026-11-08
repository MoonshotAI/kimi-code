import { truncateToWidth, visibleWidth, type Component } from '@moonshot-ai/pi-tui';
import type {
  TowerActivityEvent,
  TowerProjection,
  TowerProjectionClosedMission,
  TowerProjectionOpenMission,
} from '@moonshot-ai/kimi-code-sdk';

import { TRUNCATION_ELLIPSIS } from '#/tui/constant/rendering';
import { currentTheme, type ColorToken } from '#/tui/theme';

const LEFT_EDGE = '│';
const SIDE_PADDING = 1;
const TASKS_BAR_CELLS = 4;
const EVENTS_LIMIT = 12;
const RECENT_CLOSED_LIMIT = 8;

const MISSION_STATUS_COLORS: Record<TowerProjectionOpenMission['status'], ColorToken> = {
  active: 'primary',
  blocked: 'warning',
  paused: 'textDim',
  completed: 'success',
  planned: 'textDim',
  merged: 'success',
  abandoned: 'error',
};

const EVENT_SYMBOLS: Readonly<Record<string, string>> = {
  spawn: '✚',
  died: '☠',
  revived: '↻',
  merge: '✅',
  'merge.blocked': '⛔',
  'review.write': '👁',
  'mission.update': '●',
  plan: '▤',
};

export function formatTowerRelativeTime(at: string | undefined, now: number): string {
  if (at === undefined) return '';
  const time = Date.parse(at);
  if (Number.isNaN(time)) return '';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export class TowerPaneComponent implements Component {
  private projection: TowerProjection | undefined;

  setProjection(projection: TowerProjection | undefined): void {
    this.projection = projection;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const projection = this.projection;
    const paneWidth = Math.max(1, Math.floor(width));
    if (projection === undefined || !projection.hasContent) return [];
    const innerWidth = Math.max(0, paneWidth - SIDE_PADDING * 2 - 1);
    const lines: string[] = [];
    const push = (content: string): void => {
      lines.push(frameLine(content, paneWidth, innerWidth));
    };
    const now = Date.now();

    push(renderHeader(projection, innerWidth));
    push('');
    push(renderSectionTitle('目标', projection.openMissions.length));
    for (const mission of projection.openMissions) {
      push(renderMissionStatusLine(mission, innerWidth));
      push(renderMissionProgressLine(mission, innerWidth));
    }
    push('');
    push(renderSectionTitle('动态'));
    for (const event of projection.events.slice(-EVENTS_LIMIT).toReversed()) {
      push(renderEventLine(event, now));
    }
    push('');
    push(renderSectionTitle('近期实验'));
    for (const mission of projection.recentClosed.slice(0, RECENT_CLOSED_LIMIT)) {
      push(renderClosedMissionLine(mission, innerWidth, now));
    }
    return lines;
  }
}

function frameLine(content: string, width: number, innerWidth: number): string {
  const edge = currentTheme.fg('border', LEFT_EDGE);
  if (width <= 1) return edge;
  const fitted = truncateToWidth(content, innerWidth, TRUNCATION_ELLIPSIS);
  const padding = ' '.repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
  return `${edge} ${fitted}${padding} `;
}

function renderSectionTitle(label: string, count?: number): string {
  const title = currentTheme.boldFg('textStrong', label);
  return count === undefined ? title : `${title} ${currentTheme.fg('textMuted', `(${count})`)}`;
}

function renderHeader(projection: TowerProjection, width: number): string {
  const title =
    projection.base === undefined
      ? currentTheme.boldFg('primary', '⚡ tower')
      : `${currentTheme.boldFg('primary', '⚡ tower')}${currentTheme.fg('textDim', ' · ')}${currentTheme.fg('textDim', projection.base)}`;
  const live = projection.workersLive + projection.reviewersLive;
  const liveToken: ColorToken = live > 0 ? 'success' : 'textMuted';
  return joinSides(title, currentTheme.fg(liveToken, `${live} live`), width);
}

function joinSides(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const fittedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1), TRUNCATION_ELLIPSIS);
  const gap = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
  return `${fittedLeft}${' '.repeat(gap)}${right}`;
}

function renderMissionStatusLine(mission: TowerProjectionOpenMission, width: number): string {
  const dot = currentTheme.fg(MISSION_STATUS_COLORS[mission.status], '●');
  const prefix = `${dot} ${currentTheme.fg('textMuted', mission.id)} `;
  const titleWidth = Math.max(0, width - visibleWidth(prefix));
  const title = currentTheme.fg(
    'text',
    truncateToWidth(mission.title, titleWidth, TRUNCATION_ELLIPSIS),
  );
  return prefix + title;
}

function renderMissionProgressLine(mission: TowerProjectionOpenMission, width: number): string {
  const filled =
    mission.tasksTotal === 0
      ? 0
      : Math.min(
          TASKS_BAR_CELLS,
          Math.round((mission.tasksDone / mission.tasksTotal) * TASKS_BAR_CELLS),
        );
  const bar =
    currentTheme.fg('primary', '▓'.repeat(filled)) +
    currentTheme.fg('textMuted', '░'.repeat(TASKS_BAR_CELLS - filled));
  const parts = [`  ${bar} ${currentTheme.fg('textDim', `${mission.tasksDone}/${mission.tasksTotal}`)}`];
  if (mission.owner !== undefined && mission.owner.length > 0) {
    parts.push(currentTheme.fg('textMuted', mission.owner));
  }
  let line = parts.join(currentTheme.fg('textDim', ' · '));
  if (mission.blockers > 0) {
    line += ` ${currentTheme.fg('warning', `⚠ ${mission.blockers}`)}`;
  }
  return truncateToWidth(line, width, TRUNCATION_ELLIPSIS);
}

function renderEventLine(event: TowerActivityEvent, now: number): string {
  const time = formatTowerRelativeTime(event.at, now);
  const symbol = EVENT_SYMBOLS[event.kind] ?? '·';
  const key = event.fields['mission'] ?? event.fields['id'] ?? event.fields['branch'];
  const segments: string[] = [];
  if (time.length > 0) segments.push(currentTheme.fg('textMuted', time));
  segments.push(currentTheme.fg('accent', symbol));
  segments.push(currentTheme.fg('text', event.actor));
  if (key !== undefined && key.length > 0) segments.push(currentTheme.fg('textMuted', key));
  return segments.join(' ');
}

function renderClosedMissionLine(
  mission: TowerProjectionClosedMission,
  width: number,
  now: number,
): string {
  const mark =
    mission.status === 'merged'
      ? currentTheme.fg('success', '✅')
      : currentTheme.fg('error', '❌');
  const left = `${mark} ${currentTheme.fg('textMuted', mission.id)} ${currentTheme.fg('text', mission.title)}`;
  const relative = formatTowerRelativeTime(mission.closedAt, now);
  if (relative.length === 0) return truncateToWidth(left, width, TRUNCATION_ELLIPSIS);
  return joinSides(left, currentTheme.fg('textMuted', relative), width);
}
