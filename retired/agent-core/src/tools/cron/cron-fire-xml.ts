/**
 * Cron-fire XML rendering — produces the chat-history injection text
 * the scheduler hands to the model when a CronTask fires.
 *
 * Output shape:
 *   <cron-fire jobId="..." cron="..." recurring="true|false" coalescedCount="N" stale="true|false">
 *   <prompt>
 *   verbatim user prompt
 *   </prompt>
 *   </cron-fire>
 *
 * Mirrors `agent/context/notification-xml.ts`: attribute values are
 * escape-safe via `stringAttr`, but the body inside `<prompt>` is
 * verbatim. The injection target is an LLM-visible transcript where
 * double-escaping would be noisier than literal punctuation.
 */
import type { CronJobOrigin } from '../../agent/context/types';

export function renderCronFireXml(
  origin: CronJobOrigin,
  prompt: string,
): string {
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

function stringAttr(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  // Attribute boundary safety: escape `&` and `"`. Body-text `<` / `>`
  // stay untouched — the injection target is an LLM-visible transcript
  // where double-escaping would be noisier than literal punctuation.
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}
