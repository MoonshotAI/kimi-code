import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { CronMessageComponent } from '#/tui/components/messages/cron-message';
import type { CronTranscriptData } from '#/tui/types';

function component(data: Partial<CronTranscriptData> = {}): CronMessageComponent {
  const fullData: CronTranscriptData = {
    cron: '* * * * *',
    jobId: 'job-123',
    recurring: true,
    ...data,
  };
  return new CronMessageComponent('Run daily summary', fullData);
}

describe('CronMessageComponent', () => {
  it('renders a scheduled reminder with cron detail', () => {
    const lines = component().render(80);
    const rendered = lines.join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');

    expect(rendered).toContain('Scheduled reminder fired');
    expect(rendered).toContain('* * * * *');
    expect(rendered).toContain('job job-123');
    expect(rendered).toContain('Run daily summary');
  });

  it('renders a missed-reminder variant', () => {
    const lines = component({ missedCount: 3 }).render(80);
    const rendered = lines.join('\n').replaceAll(/\u001B\[[0-9;]*m/g, '');

    expect(rendered).toContain('Missed scheduled reminders');
    expect(rendered).toContain('3 missed');
  });

  it('keeps every line within the requested render width, even when very narrow', () => {
    for (const width of [80, 40, 20, 10, 5, 2, 1]) {
      for (const line of component().render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
