import { describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { Translator } from '../src/contracts';
import { cronScheduleText, humanizeCronSchedule } from '../src/lib/cronSchedule';

function translator(locale: 'en' | 'zh'): Translator {
  const i18n = createKimiI18n({ locale });
  return (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params));
}

const en = translator('en');
const zh = translator('zh');

describe('humanizeCronSchedule', () => {
  it.each([
    ['* * * * *', 'Every minute', '每分钟'],
    ['*/5 * * * *', 'Every 5 minutes', '每 5 分钟'],
    ['*/1 * * * *', 'Every minute', '每分钟'],
    ['7 * * * *', 'Hourly at minute 7', '每小时第 7 分钟'],
    ['30 9 * * *', 'Daily at 09:30', '每天 09:30'],
    ['0 9 * * 1-5', 'Weekdays at 09:00', '工作日 09:00'],
    ['0 9 * * 1', 'Mondays at 09:00', '每周一 09:00'],
    ['0 9 * * 7', 'Sundays at 09:00', '每周日 09:00'],
    ['0 9 15 * *', 'Monthly on day 15 at 09:00', '每月 15 日 09:00'],
    ['49 18 19 9 *', 'Yearly on Sep 19 at 18:49', '每年 9月19日 18:49'],
    ['0 0 1 1 *', 'Yearly on Jan 1 at 00:00', '每年 1月1日 00:00'],
  ])('humanizes %s in en and zh', (cron, enText, zhText) => {
    expect(humanizeCronSchedule(en, cron)).toBe(enText);
    expect(humanizeCronSchedule(zh, cron)).toBe(zhText);
  });

  it.each(['0 */2 * * *', '0 9 * * 1,3', '0 9 1-5 * *', 'not a cron', '0 9 * *', '61 * * * *', '0 25 * * *', '*/40 * * * *', '*/7 * * * *'])(
    'falls back for %s',
    (cron) => {
      expect(humanizeCronSchedule(en, cron)).toBeUndefined();
      expect(humanizeCronSchedule(zh, cron)).toBeUndefined();
    },
  );
});

describe('cronScheduleText', () => {
  it('returns the human schedule when a pattern matches', () => {
    expect(cronScheduleText(en, '*/5 * * * *')).toBe('Every 5 minutes');
    expect(cronScheduleText(zh, '*/5 * * * *')).toBe('每 5 分钟');
  });

  it('falls back to the raw expression when no pattern matches', () => {
    expect(cronScheduleText(en, '0 9 * * 1,3')).toBe('0 9 * * 1,3');
    expect(cronScheduleText(zh, '0 9 * * 1,3')).toBe('0 9 * * 1,3');
  });
});

describe('humanizeCronSchedule one-shot mode', () => {
  it('humanizes pinned one-shot datetimes', () => {
    expect(humanizeCronSchedule(en, '49 18 19 9 *', false)).toBe('Sep 19 at 18:49');
    expect(humanizeCronSchedule(zh, '49 18 19 9 *', false)).toBe('9月19日 18:49');
  });

  it.each(['0 9 * * *', '*/5 * * * *', '0 9 * * 1', '0 9 15 * *'])(
    'returns no periodic copy for one-shot %s',
    (cron) => {
      expect(humanizeCronSchedule(en, cron, false)).toBeUndefined();
      expect(humanizeCronSchedule(zh, cron, false)).toBeUndefined();
    },
  );
});
