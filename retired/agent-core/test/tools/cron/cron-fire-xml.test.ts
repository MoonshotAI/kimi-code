/**
 * Tests for `tools/cron/cron-fire-xml.ts`. Cover the attribute envelope,
 * recurring vs one-shot rendering, attribute escaping, and verbatim
 * prompt-body handling (including multi-line and quote content).
 */
import { describe, expect, it } from 'vitest';

import type { CronJobOrigin } from '../../../src/agent/context/types';
import { renderCronFireXml } from '../../../src/tools/cron/cron-fire-xml';

describe('renderCronFireXml', () => {
  it('recurring origin renders all 5 attributes in order with prompt wrapped', () => {
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: 'deadbeef',
      cron: '*/5 * * * *',
      recurring: true,
      coalescedCount: 3,
      stale: false,
    };
    const out = renderCronFireXml(origin, 'check the deploy');
    expect(out).toMatchInlineSnapshot(`
      "<cron-fire jobId="deadbeef" cron="*/5 * * * *" recurring="true" coalescedCount="3" stale="false">
      <prompt>
      check the deploy
      </prompt>
      </cron-fire>"
    `);
  });

  it('one-shot origin renders recurring="false", coalescedCount="1", stale="false"', () => {
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: 'cafebabe',
      cron: '30 14 28 2 *',
      recurring: false,
      coalescedCount: 1,
      stale: false,
    };
    const out = renderCronFireXml(origin, 'one-shot ping');
    expect(out).toContain(
      '<cron-fire jobId="cafebabe" cron="30 14 28 2 *" recurring="false" coalescedCount="1" stale="false">',
    );
    expect(out).toContain('<prompt>\none-shot ping\n</prompt>');
  });

  it('escapes `&` and `"` in attribute values; leaves prompt body verbatim', () => {
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: 'job&"id',
      cron: '0 9 * * *',
      recurring: true,
      coalescedCount: 1,
      stale: false,
    };
    const out = renderCronFireXml(origin, 'has a " quote and an & ampersand');

    // Attribute value escapes `&` and `"`.
    expect(out).toContain('jobId="job&amp;&quot;id"');
    // Body is verbatim — no escaping of `"` or `&`.
    expect(out).toContain('has a " quote and an & ampersand');
    expect(out).not.toContain('&quot; quote');
  });

  it('preserves newlines in multi-line prompt body', () => {
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: 'aaaabbbb',
      cron: '0 * * * *',
      recurring: true,
      coalescedCount: 1,
      stale: false,
    };
    const prompt = 'line one\nline two\n\nline four';
    const out = renderCronFireXml(origin, prompt);
    expect(out).toContain(`<prompt>\n${prompt}\n</prompt>`);
  });

  it('renders stale="true" when origin.stale is true', () => {
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: 'staleone',
      cron: '0 9 * * *',
      recurring: true,
      coalescedCount: 5,
      stale: true,
    };
    const out = renderCronFireXml(origin, 'morning report');
    expect(out).toContain('stale="true"');
    expect(out).toContain('coalescedCount="5"');
  });
});
