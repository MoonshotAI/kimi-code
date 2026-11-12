import { visibleWidth } from '@moonshot-ai/pi-tui';
import type { TowerProjection } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { TowerPaneComponent } from '#/tui/components/panes/tower-pane';

const WIDTH = 44;

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function atMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function makeProjection(overrides: Partial<TowerProjection> = {}): TowerProjection {
  return {
    status: 'active',
    hasContent: true,
    base: 'main',
    mode: 'branch',
    missionCounts: {
      planned: 1,
      active: 1,
      completed: 0,
      blocked: 0,
      paused: 0,
      merged: 1,
      abandoned: 1,
    },
    workersLive: 1,
    reviewersLive: 1,
    rosterTotal: 3,
    openMissions: [
      {
        id: 'M3',
        title: 'Add tower pane',
        kind: 'build',
        status: 'active',
        owner: 'worker-1',
        branch: 'tower-pane',
        scope: [],
        tasksDone: 2,
        tasksTotal: 4,
        blockers: 1,
        liveWorkers: 1,
      },
    ],
    recentClosed: [
      { id: 'M1', title: 'Old mission', status: 'merged', closedAt: atMinutesAgo(180) },
      { id: 'M2', title: 'Dropped mission', status: 'abandoned', closedAt: atMinutesAgo(60) },
    ],
    events: [
      { at: atMinutesAgo(5), actor: 'worker-1', kind: 'spawn', fields: { mission: 'M3' } },
      { at: atMinutesAgo(2), actor: 'lead', kind: 'merge', fields: { branch: 'feat/x' } },
    ],
    logOffset: 0,
    ...overrides,
  };
}

function render(projection: TowerProjection | undefined): string[] {
  const pane = new TowerPaneComponent();
  pane.setProjection(projection);
  return pane.render(WIDTH).map(stripAnsi);
}

describe('TowerPaneComponent', () => {
  it('renders the header, live count and all three sections', () => {
    const lines = render(makeProjection());
    const output = lines.join('\n');

    expect(lines[0]).toContain('⚡ tower · main');
    expect(lines[0]).toContain('2 live');
    expect(output).toContain('目标 (1)');
    expect(output).toContain('● M3 Add tower pane');
    expect(output).toContain('▓▓░░ 2/4 · worker-1 ⚠ 1');
    expect(output).toContain('动态');
    expect(output).toContain('近期实验');
  });

  it('lists the newest events first with their kind symbol and key field', () => {
    const lines = render(makeProjection());
    const mergeIndex = lines.findIndex((line) => line.includes('✅ lead'));
    const spawnIndex = lines.findIndex((line) => line.includes('✚ worker-1 M3'));

    expect(mergeIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(-1);
    expect(mergeIndex).toBeLessThan(spawnIndex);
    expect(lines[mergeIndex]).toContain('2m');
  });

  it('marks merged and abandoned missions in the recent list', () => {
    const output = render(makeProjection()).join('\n');

    expect(output).toContain('✅ M1 Old mission');
    expect(output).toContain('❌ M2 Dropped mission');
    expect(output).toContain('3h');
  });

  it('truncates long content to the pane width', () => {
    const projection = makeProjection({
      openMissions: [
        {
          id: 'M9',
          title: 'a very long mission title that cannot possibly fit into the narrow pane',
          kind: 'build',
          status: 'blocked',
          branch: 'long',
          scope: [],
          tasksDone: 0,
          tasksTotal: 3,
          blockers: 0,
          liveWorkers: 0,
        },
      ],
    });
    const lines = render(projection);

    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
      expect(line.startsWith('│')).toBe(true);
    }
    expect(lines.some((line) => line.includes('…'))).toBe(true);
  });

  it('keeps section headers when there are no events or closed missions', () => {
    const output = render(makeProjection({ events: [], recentClosed: [] })).join('\n');

    expect(output).toContain('目标 (1)');
    expect(output).toContain('动态');
    expect(output).toContain('近期实验');
  });

  it('removes terminal control sequences from projection fields', () => {
    const pane = new TowerPaneComponent();
    pane.setProjection(
      makeProjection({
        base: 'main\u001B]0;owned\u0007',
        openMissions: [
          {
            id: 'M3\u001Bc',
            title: 'Safe\u001B[2J title',
            kind: 'build',
            status: 'active',
            owner: 'worker\u001B]8;;https://example.com\u001B\\',
            branch: 'tower-pane',
            scope: [],
            tasksDone: 2,
            tasksTotal: 4,
            blockers: 0,
            liveWorkers: 1,
          },
        ],
        recentClosed: [
          {
            id: 'M1',
            title: 'Old\u001B[2J mission',
            status: 'merged',
            closedAt: atMinutesAgo(60),
          },
        ],
        events: [
          {
            at: atMinutesAgo(2),
            actor: 'lead\u0007',
            kind: 'spawn',
            fields: { mission: 'M3\u001B[?1049h' },
          },
        ],
      }),
    );

    const output = pane.render(WIDTH).join('\n');

    expect(output).not.toContain('\u001B]');
    expect(output).not.toContain('\u001B[2J');
    expect(output).not.toContain('\u001B[?1049h');
    expect(output).not.toContain('\u001Bc');
    expect(output).not.toContain('\u0007');
    expect(stripAnsi(output)).toContain('Safe title');
    expect(stripAnsi(output)).toContain('Old mission');
  });

  it('renders nothing without a projection or content', () => {
    expect(render(undefined)).toEqual([]);
    expect(render(makeProjection({ hasContent: false }))).toEqual([]);
  });
});
