import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { CronMessageComponent } from '#/tui/components/messages/cron-message';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from '#/tui/components/messages/status-message';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('NoticeComponent', () => {
  it('renders top and bottom spacing around the notice copy', () => {
    const component = new NoticeMessageComponent(
      'Plan mode: ON',
      'Plan will be created here: /tmp/plans/test-plan.md',
    );

    const lines = component.render(120).map((line) => strip(line));
    expect(lines[0]).toBe('');
    expect(lines[1]).toContain('Plan mode: ON');
    expect(lines[2]).toContain('Plan will be created here: /tmp/plans/test-plan.md');
  });
});

describe('CronMessageComponent', () => {
  it('keeps title, detail, and prompt within narrow widths', () => {
    const component = new CronMessageComponent('Please investigate the reminder payload and report back.', {
      cron: '*/15 * * * *',
      jobId: 'job-with-a-very-long-identifier-for-width-testing',
      recurring: true,
      missedCount: 3,
      stale: true,
    });

    for (const width of [39, 20, 10, 4]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('StatusMessageComponent', () => {
  it('strips carriage returns so a CRLF line does not render blank', () => {
    // A trailing `\r` (e.g. from a CRLF server error page) is zero-width for
    // the line wrapper, so padding spaces appended after it would otherwise
    // overwrite the visible content. The status component strips `\r`.
    const component = new StatusMessageComponent('Error: boom\r\nmore\r', 'error');
    const text = component
      .render(120)
      .map((line) => strip(line))
      .join('\n');
    expect(text).toContain('Error: boom');
    expect(text).toContain('more');
    expect(text).not.toContain('\r');
  });
});
