import { formatDuration } from '../lib/formatDuration';
import type { TaskNotification } from './types';

export type NotificationStatus = 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost' | 'info';

export function notificationStatus(n: { type: string }): NotificationStatus {
  for (const s of ['completed', 'failed', 'timed_out', 'killed', 'lost'] as const) {
    if (n.type.endsWith(`.${s}`)) return s;
  }
  return 'info';
}

export type NotificationVariant = 'ok' | 'err' | 'warn' | 'info';

export function notificationVariant(n: TaskNotification): NotificationVariant {
  const status = notificationStatus(n);
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'timed_out' || status === 'lost') return 'err';
  if (status === 'killed') return 'warn';
  if (n.severity === 'error') return 'err';
  if (n.severity === 'warning') return 'warn';
  return 'info';
}

const STOCK_TITLE_RE = /^Background (?:process|agent) (completed|failed|timed[_ ]out|killed|lost)$/i;

export function isStockNotificationTitle(title: string): boolean {
  return STOCK_TITLE_RE.test(title.trim());
}

export interface StockNotificationBody {
  status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
  description: string;
  wallTimeMs?: number;
  reason?: string;
  userStopped?: boolean;
  rest?: string;
}

const WALL_TIME_RE = /^Wall time:\s*(\d+(?:\.\d+)?)\s*seconds?$/i;
const STOCK_STATUS_RE = /^(.+?) (completed|failed|timed out|lost)\.(?: Reason: ([\s\S]+))?$/;
const STOCK_STOPPED_RE = /^(.+?) was stopped( by user)?\.(?: Reason: ([\s\S]+))?$/;
const STOCK_V1_REASON_RE = /^(.+?) (completed|failed|timed out|lost|was killed): ([\s\S]+)\.$/;
const SUBAGENT_RECOVERY_PREFIX = 'To recover or continue this subagent, call Agent(';

export function splitNotificationWallTime(body: string): { wallTimeMs?: number; content: string; hadWallTime: boolean } {
  const nl = body.indexOf('\n');
  const first = (nl === -1 ? body : body.slice(0, nl)).trim();
  const match = WALL_TIME_RE.exec(first);
  if (!match?.[1]) return { content: body, hadWallTime: false };
  const ms = Math.round(Number(match[1]) * 1000);
  const wallTimeMs = Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  return {
    wallTimeMs,
    content: nl === -1 ? '' : body.slice(nl + 1),
    hadWallTime: true,
  };
}

export function formatNotificationDuration(ms: number | undefined, locale: string = 'en'): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms === 0) return formatDuration(0, locale, { secondsDisplay: 'always' });
  if (ms < 1000) return '<1s';
  return formatDuration(ms, locale);
}

export function compactNotificationOutputPath(path: string): string {
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 2) return norm;
  return parts.slice(-2).join('/');
}

export function cleanNotificationRest(rest: string | undefined): string | undefined {
  if (rest === undefined || rest === '') return undefined;
  const idx = rest.indexOf(SUBAGENT_RECOVERY_PREFIX);
  if (idx === -1) return rest;
  const trimmed = rest.slice(0, idx).trim();
  return trimmed === '' ? undefined : trimmed;
}

export function parseStockNotificationBody(body: string): StockNotificationBody | undefined {
  const { wallTimeMs, content, hadWallTime } = splitNotificationWallTime(body);
  if (hadWallTime && content.trim() === '') return undefined;

  const nl = content.indexOf('\n');
  const first = (nl === -1 ? content : content.slice(0, nl)).trim();
  const tail = nl === -1 ? '' : content.slice(nl + 1).trim();
  const rest = tail === '' ? undefined : tail;
  const timing = wallTimeMs !== undefined ? { wallTimeMs } : {};

  const finish = (
    parsed: StockNotificationBody,
  ): StockNotificationBody | undefined => {
    if (/^Background (process|agent)$/.test(parsed.description)) {
      parsed = { ...parsed, description: '' };
    }
    return parsed;
  };

  const status = STOCK_STATUS_RE.exec(first);
  if (status?.[1] !== undefined && status[2] !== undefined) {
    return finish({
      status: status[2] === 'timed out' ? 'timed_out' : (status[2] as StockNotificationBody['status']),
      description: status[1],
      reason: status[3],
      rest,
      ...timing,
    });
  }
  const stopped = STOCK_STOPPED_RE.exec(first);
  if (stopped?.[1] !== undefined) {
    return finish({
      status: 'killed',
      description: stopped[1],
      userStopped: stopped[2] !== undefined,
      reason: stopped[3],
      rest,
      ...timing,
    });
  }
  const v1 = STOCK_V1_REASON_RE.exec(first);
  if (v1?.[1] !== undefined && v1[2] !== undefined) {
    return finish({
      status:
        v1[2] === 'was killed'
          ? 'killed'
          : v1[2] === 'timed out'
            ? 'timed_out'
            : (v1[2] as StockNotificationBody['status']),
      description: v1[1],
      reason: v1[3],
      rest,
      ...timing,
    });
  }
  return undefined;
}

export function stockNotificationDisplay(
  n: Pick<TaskNotification, 'title' | 'body' | 'type'>,
): StockNotificationBody | undefined {
  if (!isStockNotificationTitle(n.title)) return undefined;
  const stock = parseStockNotificationBody(n.body);
  if (stock === undefined || stock.status !== notificationStatus(n)) return undefined;
  return stock;
}
