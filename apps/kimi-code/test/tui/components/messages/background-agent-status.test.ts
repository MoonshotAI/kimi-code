import { TuiAltScreen, visibleWidth, type Component } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { BackgroundAgentStatusComponent } from '#/tui/components/messages/background-agent-status';
import {
  flattenTranscriptRow,
  TranscriptRowLayout,
} from '#/tui/components/messages/transcript-row-layout';
import { STATUS_BULLET } from '#/tui/constant/symbols';

import { VirtualTerminal } from '../../../../../../packages/pi-tui/test/virtual-terminal';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

async function expectLogicalLineCopy(
  component: Component,
  source: string,
): Promise<void> {
  const terminal = new VirtualTerminal(12, 10);
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
    const firstNeedle = source.slice(0, 4);
    const lastNeedle = source.slice(-4);
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

  it('separates the status marker and continuation indent from headline content', () => {
    const component = new BackgroundAgentStatusComponent({
      phase: 'failed',
      headline: 'explore agent failed',
      detail: 'boom',
    });
    const width = 30;
    const parts = component.renderTranscriptRow(width);

    expect(parts.contentLines.map((line) => strip(line.text))).toEqual([
      '',
      'explore agent failed (boom)',
    ]);
    expect(parts.gutterLines.map((line) => strip(line.text))).toEqual(['', '✗ ']);
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

  it('copies a soft-wrapped headline without the bullet or continuation indent', async () => {
    const source = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const component = new BackgroundAgentStatusComponent({ phase: 'started', headline: source });
    await expectLogicalLineCopy(component, source);
    await expectLogicalLineCopy(new TranscriptRowLayout(component), source);
  });
});
