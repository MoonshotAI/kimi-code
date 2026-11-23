import type { Translator } from '../contracts';

const INT = /^\d+$/;
const MINUTE_STEP = /^\*\/(\d+)$/;

function fieldInt(s: string, min: number, max: number): number | undefined {
  if (!INT.test(s)) return undefined;
  const v = Number.parseInt(s, 10);
  return v >= min && v <= max ? v : undefined;
}

function pad2(v: number): string {
  return v < 10 ? `0${v}` : String(v);
}

export function cronScheduleText(t: Translator, cron: string, recurring = true): string {
  return humanizeCronSchedule(t, cron, recurring) ?? cron;
}

export function humanizeCronSchedule(t: Translator, cron: string, recurring = true): string | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];
  const hourWild = hourF === '*';
  const domWild = domF === '*';
  const monthWild = monthF === '*';
  const dowWild = dowF === '*';

  if (!recurring && (domWild || monthWild || !dowWild)) return undefined;

  if (hourWild && domWild && monthWild && dowWild) {
    if (minF === '*') return t('tools.cron.schedule.everyMinute');
    const step = MINUTE_STEP.exec(minF)?.[1];
    if (step !== undefined) {
      const n = Number.parseInt(step, 10);
      if (n === 1) return t('tools.cron.schedule.everyMinute');
      return n > 1 && n <= 59 && 60 % n === 0 ? t('tools.cron.schedule.everyNMinutes', { n }) : undefined;
    }
    const minute = fieldInt(minF, 0, 59);
    return minute === undefined ? undefined : t('tools.cron.schedule.hourlyAt', { minute });
  }

  const minute = fieldInt(minF, 0, 59);
  const hour = fieldInt(hourF, 0, 23);
  if (minute === undefined || hour === undefined) return undefined;
  const time = `${pad2(hour)}:${pad2(minute)}`;

  if (domWild && monthWild) {
    if (dowWild) return t('tools.cron.schedule.dailyAt', { time });
    if (dowF === '1-5') return t('tools.cron.schedule.weekdaysAt', { time });
    const dow = fieldInt(dowF, 0, 7);
    if (dow === undefined) return undefined;
    return t('tools.cron.schedule.weeklyAt', {
      day: t(`tools.cron.schedule.day.${dow === 7 ? 0 : dow}`),
      time,
    });
  }

  if (dowWild) {
    const dom = fieldInt(domF, 1, 31);
    if (dom === undefined) return undefined;
    if (monthWild) return t('tools.cron.schedule.monthlyAt', { day: dom, time });
    const month = fieldInt(monthF, 1, 12);
    if (month === undefined) return undefined;
    const date = t('tools.cron.schedule.dateMD', {
      month: t(`tools.cron.schedule.monthShort.${month}`),
      day: dom,
    });
    return recurring
      ? t('tools.cron.schedule.yearlyAt', { date, time })
      : t('tools.cron.schedule.onceAt', { date, time });
  }

  return undefined;
}
