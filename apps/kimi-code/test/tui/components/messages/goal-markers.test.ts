import { describe, expect, it } from 'vitest';

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
