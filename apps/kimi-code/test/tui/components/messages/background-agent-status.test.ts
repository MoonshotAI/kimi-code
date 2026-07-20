import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { BackgroundAgentStatusComponent } from '#/tui/components/messages/background-agent-status';
import { STATUS_BULLET } from '#/tui/constant/symbols';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('BackgroundAgentStatusComponent', () => {
  it('renders started/completed with the shared bullet and failed with a red x marker', () => {
    const started = new BackgroundAgentStatusComponent({
      phase: 'started',
      headline: 'explore agent started in background',
      detail: 'Explore project structure',
    });
    const completed = new BackgroundAgentStatusComponent({
      phase: 'completed',
      headline: 'explore agent completed in background',
      detail: 'Explore project structure',
    });
    const failed = new BackgroundAgentStatusComponent({
      phase: 'failed',
      headline: 'explore agent failed in background',
      detail: 'Explore project structure · boom',
    });

    const startedLines = started.render(120).map((line) => strip(line).trimEnd());
    const completedLines = completed.render(120).map((line) => strip(line).trimEnd());
    const failedLines = failed.render(120).map((line) => strip(line).trimEnd());

    expect(startedLines[0]).toBe('');
    expect(completedLines[0]).toBe('');
    expect(failedLines[0]).toBe('');

    expect(startedLines[1]).toBe(
      `${STATUS_BULLET}explore agent started in background (Explore project structure)`,
    );
    expect(completedLines[1]).toBe(
      `${STATUS_BULLET}explore agent completed in background (Explore project structure)`,
    );
    expect(failedLines[1]).toBe(
      '✗ explore agent failed in background (Explore project structure · boom)',
    );
  });

  it('keeps status lines within very narrow widths', () => {
    const component = new BackgroundAgentStatusComponent({
      phase: 'started',
      headline: 'explore agent started in background',
      detail: 'Explore project structure',
    });

    for (const width of [1, 2, 4, 10, 39]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
