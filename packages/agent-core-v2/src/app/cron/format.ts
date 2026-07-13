/**
 * LLM-facing text rendering for the cron domain: local-time timestamps for
 * tool output, and the `<cron-fire>` injection the scheduler hands to the model
 * when a task fires.
 *
 * Both renderers stay dependency-free so the tools and the service can import
 * them without pulling in the rest of the cron stack.
 */

import type { CronJobOrigin } from '@moonshot-ai/protocol';

/**
 * Render a wall-clock epoch-ms value in local time with an explicit numeric
 * offset. Cron expressions are evaluated in local time, so tool output keeps
 * that mental model while staying unambiguous and ISO-8601-parseable.
 */
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

/**
 * Render the chat-history injection text delivered when a cron task fires.
 * Attribute values are escape-safe via `stringAttr`; the body inside `<prompt>`
 * is verbatim — double-escaping would be noisier than literal punctuation in an
 * LLM-visible transcript.
 */
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
