import type { CronJobOrigin } from '#/agent/contextMemory/types';

export function formatLocalIsoWithOffset(ms: number): string {
  const date = new Date(ms);
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(
    3,
    '0',
  )}${offset}`;
}

export function renderCronFireXml(origin: CronJobOrigin, prompt: string): string {
  const jobId = stringAttr(origin.jobId, 'unknown');
  const cron = stringAttr(origin.cron, 'unknown');
  const recurring = origin.recurring ? 'true' : 'false';
  const coalescedCount = String(origin.coalescedCount);
  const stale = origin.stale ? 'true' : 'false';

  return [
    `<cron-fire jobId="${jobId}" cron="${cron}" recurring="${recurring}" coalescedCount="${coalescedCount}" stale="${stale}">`,
    '<prompt>',
    prompt,
    '</prompt>',
    '</cron-fire>',
  ].join('\n');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function stringAttr(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}
