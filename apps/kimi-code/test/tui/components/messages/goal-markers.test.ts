import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { SwarmModeMarkerComponent } from '#/tui/components/messages/swarm-markers';
import { buildGoalMarker, GoalMarkerComponent } from '#/tui/components/messages/goal-markers';
import type { GoalChange } from '@moonshot-ai/kimi-code-sdk';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(lines: string[]): string {
  return lines.join('\n').replaceAll(ANSI_SGR, '');
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
});

describe('SwarmModeMarkerComponent', () => {
  it('keeps marker lines within very narrow widths', () => {
    const marker = new SwarmModeMarkerComponent('active');

    for (const width of [1, 2, 10, 39]) {
      for (const line of marker.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
