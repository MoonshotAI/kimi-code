import { TuiAltScreen, visibleWidth, type Component } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { CronMessageComponent } from '#/tui/components/messages/cron-message';
import {
  flattenTranscriptRow,
  TranscriptRowLayout,
} from '#/tui/components/messages/transcript-row-layout';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from '#/tui/components/messages/status-message';

import { VirtualTerminal } from '../../../../../../packages/pi-tui/test/virtual-terminal';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

async function expectLogicalLineCopy(
  component: Component,
  source: string,
  width = 12,
): Promise<void> {
  const terminal = new VirtualTerminal(width, 20);
  const copied: string[] = [];
  const tui = new TuiAltScreen(terminal, undefined, undefined, {
    copySelection: async (text) => {
      copied.push(text);
      return true;
    },
  });
  tui.addChild(component);
  tui.start();
  try {
    await terminal.waitForRender();
    const rows = tui.getScreenLines().map(strip);
    const needleLength = Math.min(4, Math.max(1, Math.floor(width / 2)), source.length);
    const firstNeedle = source.slice(0, needleLength);
    const lastNeedle = source.slice(-needleLength);
    const startRow = rows.findIndex((line) => line.includes(firstNeedle));
    const endRow = rows.findLastIndex((line) => line.includes(lastNeedle));
    expect(startRow).toBeGreaterThanOrEqual(0);
    expect(endRow).toBeGreaterThanOrEqual(startRow);
    const startColumn = rows[startRow]!.indexOf(firstNeedle) + 1;
    const endColumn = rows[endRow]!.indexOf(lastNeedle) + lastNeedle.length;
    terminal.sendInput(`\u001B[<0;${startColumn};${startRow + 1}M`);
    terminal.sendInput(`\u001B[<32;${endColumn};${endRow + 1}M`);
    terminal.sendInput(`\u001B[<0;${endColumn};${endRow + 1}m`);
    await terminal.waitForRender();
    expect(copied).toEqual([source]);
  } finally {
    tui.stop();
  }
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

  it('indents every line of a multi-line detail, not just the first', () => {
    const component = new NoticeMessageComponent('Title', 'First line.\nSecond line.');

    const lines = component.render(120).map((line) => strip(line));
    const titleColumn = lines.find((line) => line.includes('Title'))?.indexOf('Title');
    const firstColumn = lines.find((line) => line.includes('First line.'))?.indexOf('First line.');
    const secondColumn = lines.find((line) => line.includes('Second line.'))?.indexOf('Second line.');
    expect(titleColumn).toBeDefined();
    expect(firstColumn).toBe(titleColumn);
    expect(secondColumn).toBe(titleColumn);
  });

  it('uses the full remaining body width at 20 columns', () => {
    const source = '123456789012345678';
    const lines = new NoticeMessageComponent(source, undefined)
      .render(20)
      .map((line) => strip(line).trimEnd())
      .filter((line) => line.length > 0);
    expect(lines).toEqual([`  ${source}`]);
  });

  it('separates notice alignment from the title and detail content', () => {
    const component = new NoticeMessageComponent('Title', 'Detail');
    const width = 20;
    const parts = component.renderTranscriptRow(width);

    expect(parts.gutterWidth).toBe(2);
    expect(parts.contentLines.map((line) => strip(line.text))).toEqual(['', 'Title', 'Detail']);
    expect(parts.gutterLines.map((line) => strip(line.text))).toEqual(['', '  ', '  ']);
    expect(
      flattenTranscriptRow(parts, width).map((line) => strip(line.text).trimEnd()),
    ).toEqual(component.render(width).map((line) => strip(line).trimEnd()));
  });

  it('copies a soft-wrapped title without visual newlines or indentation', async () => {
    const component = new NoticeMessageComponent('1234567890ABCDEFGHIJKLMNOP', undefined);
    await expectLogicalLineCopy(component, '1234567890ABCDEFGHIJKLMNOP');
    await expectLogicalLineCopy(
      new TranscriptRowLayout(component),
      '1234567890ABCDEFGHIJKLMNOP',
    );
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

  it('keeps the bullet and continuation alignment out of cron content', () => {
    const component = new CronMessageComponent('Investigate the reminder.', {
      cron: '*/15 * * * *',
      recurring: true,
    });
    const width = 40;
    const parts = component.renderTranscriptRow(width);
    const content = parts.contentLines.map((line) => strip(line.text));

    expect(content[0]).toBe('');
    expect(content).toContain('Scheduled reminder fired');
    expect(content).toContain('*/15 * * * *');
    expect(content).toContain('Investigate the reminder.');
    expect(content.join('\n')).not.toContain('●');
    expect(strip(parts.gutterLines[1]!.text)).toBe('● ');
    expect(
      flattenTranscriptRow(parts, width).map((line) => strip(line.text).trimEnd()),
    ).toEqual(component.render(width).map((line) => strip(line).trimEnd()));
    for (const narrowWidth of [1, 2, 4]) {
      const narrowParts = component.renderTranscriptRow(narrowWidth);
      for (const line of flattenTranscriptRow(narrowParts, narrowWidth)) {
        expect(visibleWidth(line.text)).toBeLessThanOrEqual(narrowWidth);
      }
    }
  });

  it('copies a soft-wrapped prompt without visual newlines or indentation', async () => {
    const source = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const component = new CronMessageComponent(source, { recurring: true });
    await expectLogicalLineCopy(component, source);
    await expectLogicalLineCopy(new TranscriptRowLayout(component), source);
  });
});

describe('StatusMessageComponent', () => {
  it('strips carriage returns so a CRLF line does not render blank', () => {
    const component = new StatusMessageComponent('Error: boom\r\nmore\r', 'error');
    const text = component
      .render(120)
      .map((line) => strip(line))
      .join('\n');
    expect(text).toContain('Error: boom');
    expect(text).toContain('more');
    expect(text).not.toContain('\r');
  });

  it('uses the full remaining body width at 20 columns', () => {
    const source = '123456789012345678';
    const lines = new StatusMessageComponent(source)
      .render(20)
      .map((line) => strip(line).trimEnd())
      .filter((line) => line.length > 0);
    expect(lines).toEqual([`  ${source}`]);
  });

  it('wraps at the body boundary at 20 columns', () => {
    const lines = new StatusMessageComponent('1234567890123456789')
      .render(20)
      .map((line) => strip(line).trimEnd())
      .filter((line) => line.length > 0);
    expect(lines).toEqual(['  123456789012345678', '  9']);
  });

  it.each([1, 2, 4])('preserves and copies body cells at width %i', async (width) => {
    const source = 'abcd';
    const component = new StatusMessageComponent(source);
    const body = component
      .render(width)
      .map((line) => strip(line).trimStart())
      .join('');
    expect(body).toBe(source);
    await expectLogicalLineCopy(component, source, width);
  });

  it('separates status alignment and refreshes row content after an update', () => {
    const component = new StatusMessageComponent('before');
    const initial = component.renderTranscriptRow(20);

    expect(initial.contentLines.map((line) => strip(line.text))).toEqual(['before']);
    expect(initial.gutterLines.map((line) => strip(line.text))).toEqual(['  ']);
    component.updateContent('after');
    const updated = component.renderTranscriptRow(20);
    expect(updated.contentLines.map((line) => strip(line.text))).toEqual(['after']);
    expect(updated.contentLines).not.toBe(initial.contentLines);
    expect(
      flattenTranscriptRow(updated, 20).map((line) => strip(line.text).trimEnd()),
    ).toEqual(component.render(20).map((line) => strip(line).trimEnd()));
  });

  it('copies a soft-wrapped status without visual newlines or indentation', async () => {
    const source = '1234567890ABCDEFGHIJKLMNOP';
    const component = new StatusMessageComponent(source);
    await expectLogicalLineCopy(component, source);
    await expectLogicalLineCopy(new TranscriptRowLayout(component), source);
  });
});
