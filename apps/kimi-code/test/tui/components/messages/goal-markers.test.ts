import { TuiAltScreen, visibleWidth, type Component } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { SwarmModeMarkerComponent } from '#/tui/components/messages/swarm-markers';
import {
  flattenTranscriptRow,
  TranscriptRowLayout,
} from '#/tui/components/messages/transcript-row-layout';
import { buildGoalMarker, GoalMarkerComponent } from '#/tui/components/messages/goal-markers';
import type { GoalChange } from '@moonshot-ai/kimi-code-sdk';

import { VirtualTerminal } from '../../../../../../packages/pi-tui/test/virtual-terminal';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(lines: string[]): string {
  return lines.join('\n').replaceAll(ANSI_SGR, '');
}

async function expectLogicalLineCopy(component: Component, source: string): Promise<void> {
  const terminal = new VirtualTerminal(12, 20);
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
    const rows = tui.getScreenLines().map((line) => strip([line]));
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

describe('buildGoalMarker', () => {
  it('builds lifecycle markers for paused / resumed / blocked', () => {
    const paused = buildGoalMarker({ kind: 'lifecycle', status: 'paused' } as GoalChange, false);
    const resumed = buildGoalMarker({ kind: 'lifecycle', status: 'active' } as GoalChange, false);
    const blocked = buildGoalMarker({ kind: 'lifecycle', status: 'blocked' } as GoalChange, false);
    expect(strip(paused!.render(80))).toContain('Goal paused');
    expect(strip(resumed!.render(80))).toContain('Goal resumed');
    expect(strip(blocked!.render(80))).toContain('Goal blocked');
  });

  it('renders user interruption pause and user resume as prominent markers', () => {
    const paused = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused', reason: 'Paused after interruption' } as GoalChange,
      false,
      'runtime',
    );
    const resumed = buildGoalMarker(
      { kind: 'lifecycle', status: 'active' } as GoalChange,
      false,
      'user',
    );

    expect(strip(paused!.render(80))).toBe("\n● Goal paused due to user's interruption");
    expect(strip(resumed!.render(80))).toBe('\n● Goal resumed by the user.');
    expect(strip([...paused!.render(80), ...resumed!.render(80)])).toBe(
      "\n● Goal paused due to user's interruption\n\n● Goal resumed by the user.",
    );
  });

  it('does not repeat paused for runtime pause reasons', () => {
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused', reason: 'Paused after runtime error: socket hang up' } as GoalChange,
      false,
      'runtime',
    );

    expect(strip(marker!.render(80))).toBe('\n● Goal paused after runtime error: socket hang up');
  });

  it('keeps long provider pause markers within the terminal width', () => {
    const reason =
      'Paused after provider API error: 400 {"error":{"message":"request id: 456043b9-6491-11f1-9425-2221bb1af97c, \\"thinking.enabled\\" is not supported for this model. Use \\"thinking.adaptive\\" and \\"output_config.effort\\" to control thinking behavior.","type":"invalid_request_error"}}';
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused', reason } as GoalChange,
      false,
      'runtime',
    );

    const width = 80;
    expect(strip(marker!.render(width))).toContain('Goal paused after provider API error');
    for (const line of marker!.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('attributes model pause and resume markers to the agent', () => {
    const paused = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused' } as GoalChange,
      false,
      'model',
    );
    const resumed = buildGoalMarker(
      { kind: 'lifecycle', status: 'active' } as GoalChange,
      false,
      'model',
    );

    expect(strip(paused!.render(80))).toBe('\n● Goal paused by the agent.');
    expect(strip(resumed!.render(80))).toBe('\n● Goal resumed by the agent.');
  });

  it('returns null for a completion change (it posts its own message)', () => {
    expect(
      buildGoalMarker({ kind: 'completion', status: 'complete' } as GoalChange, false),
    ).toBeNull();
  });
});

describe('GoalMarkerComponent', () => {
  it('hides the reason until expanded, with a ctrl+o hint', () => {
    const marker = new GoalMarkerComponent('Goal: no progress', 'still spinning', 'warning');
    const collapsed = strip(marker.render(80));
    expect(collapsed).toContain('Goal: no progress');
    expect(collapsed).toContain('(ctrl+o)');
    expect(collapsed).not.toContain('still spinning');

    marker.setExpanded(true);
    const expanded = strip(marker.render(80));
    expect(expanded).toContain('still spinning');
    expect(expanded).not.toContain('(ctrl+o)');
  });

  it('renders a single line when there is no reason', () => {
    const marker = new GoalMarkerComponent('Goal paused', undefined, 'textDim');
    expect(marker.render(80)).toHaveLength(1);
    expect(strip(marker.render(80))).not.toContain('(ctrl+o)');
  });

  it('aligns expanded detail continuations at narrow widths', () => {
    const marker = new GoalMarkerComponent(
      'Goal blocked',
      'alpha beta gamma delta epsilon zeta',
      'warning',
    );
    marker.setExpanded(true);
    for (const width of [4, 10, 20]) {
      const lines = marker.render(width);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      if (width <= 4) continue;
      const detail = lines.slice(1).map((line) => strip([line]));
      for (const line of detail) expect(line.startsWith('    ')).toBe(true);
    }
  });

  it('uses per-row gutters for the headline and expanded detail', () => {
    const marker = new GoalMarkerComponent('Goal blocked', 'still spinning', 'warning');
    const collapsed = marker.renderTranscriptRow(40);
    expect(strip(collapsed.contentLines.map((line) => line.text))).toBe(
      'Goal blocked (ctrl+o)',
    );
    expect(strip(collapsed.gutterLines.map((line) => line.text))).toBe('  ◦ ');

    marker.setExpanded(true);
    const expanded = marker.renderTranscriptRow(40);
    expect(strip(expanded.contentLines.map((line) => line.text))).toBe(
      'Goal blocked\nstill spinning',
    );
    expect(strip(expanded.gutterLines.map((line) => line.text))).toBe('  ◦ \n    ');
    expect(expanded.gutterWidths).toEqual([visibleWidth('  ◦ '), 4]);
    expect(
      flattenTranscriptRow(expanded, 40).map((line) => strip([line.text]).trimEnd()),
    ).toEqual(marker.render(40).map((line) => strip([line]).trimEnd()));
  });

  it('copies a soft-wrapped expanded detail without visual newlines or indentation', async () => {
    const source = 'alpha beta gamma delta epsilon zeta';
    const marker = new GoalMarkerComponent('Goal blocked', source, 'warning');
    marker.setExpanded(true);
    await expectLogicalLineCopy(marker, source);
    await expectLogicalLineCopy(new TranscriptRowLayout(marker), source);
  });
});

describe('SwarmModeMarkerComponent', () => {
  it('separates the status bullet from the swarm label', () => {
    const marker = new SwarmModeMarkerComponent('active');
    const width = 30;
    const parts = marker.renderTranscriptRow(width);

    expect(strip(parts.contentLines.map((line) => line.text))).toBe('\nSwarm activated');
    expect(strip(parts.gutterLines.map((line) => line.text))).toBe('\n● ');
    expect(
      flattenTranscriptRow(parts, width).map((line) => strip([line.text]).trimEnd()),
    ).toEqual(marker.render(width).map((line) => strip([line]).trimEnd()));
  });

  it('keeps marker lines within very narrow widths', () => {
    const marker = new SwarmModeMarkerComponent('active');

    for (const width of [1, 2, 10, 39]) {
      for (const line of marker.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
