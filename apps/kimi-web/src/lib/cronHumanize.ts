// apps/kimi-web/src/lib/cronHumanize.ts
// Turn a 5-field cron expression into a short human-readable label for the
// cron notice header (e.g. "*/5 * * * *" → "Every 5 minutes"). Falls back to
// the raw expression for anything we don't recognize — better to show the
// truth than a wrong friendly label.

type Translator = (key: string, params?: Record<string, unknown>) => string;

function pad2(n: string): string {
  return n.length === 1 ? `0${n}` : n;
}

/** 9:05-style time (hour not zero-padded, minute zero-padded). */
function clockTime(hour: string, minute: string): string {
  return `${String(Number(hour))}:${pad2(minute)}`;
}

const isNum = (s: string): boolean => /^\d+$/.test(s);

export function humanizeCron(expr: string, t: Translator): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return expr;
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const restWild = dom === '*' && mon === '*' && dow === '*';
  const domMonWild = dom === '*' && mon === '*';

  if (m === '*' && h === '*' && restWild) return t('conversation.cron.everyMinute');

  const everyNMin = /^\*\/(\d+)$/.exec(m);
  if (everyNMin && h === '*' && restWild) {
    if (everyNMin[1] === '1') return t('conversation.cron.everyMinute');
    return t('conversation.cron.everyNMinutes', { n: everyNMin[1]! });
  }

  if (m === '0' && h === '*' && restWild) return t('conversation.cron.everyHour');

  const everyNHour = /^\*\/(\d+)$/.exec(h);
  if (m === '0' && everyNHour && restWild) {
    return t('conversation.cron.everyNHours', { n: everyNHour[1]! });
  }

  if (isNum(m) && isNum(h) && domMonWild) {
    const time = clockTime(h, m);
    if (dow === '1-5') return t('conversation.cron.weekdaysAt', { time });
    if (dow === '*') return t('conversation.cron.dailyAt', { time });
  }

  return expr;
}
