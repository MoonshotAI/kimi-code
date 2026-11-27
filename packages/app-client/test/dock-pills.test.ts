import { describe, expect, it } from 'vitest';
import type { DockPillKey, DockPillMeasure } from '../src/lib/dockPills';
import { dockTasksPillPriority, LIVE_PILL_PRIORITY, planDockPillCollapse } from '../src/lib/dockPills';

function pill(key: DockPillKey, priority: number, expandedWidth = 100, collapsedWidth = 32): DockPillMeasure {
  return { key, priority, expandedWidth, collapsedWidth };
}

function plan(input: {
  pills: DockPillMeasure[];
  availableWidth: number;
  dockWidth?: number;
  collapsed?: DockPillKey[];
  collapsedAt?: Partial<Record<DockPillKey, number>>;
}) {
  return planDockPillCollapse({
    pills: input.pills,
    availableWidth: input.availableWidth,
    gap: 8,
    collapsed: input.collapsed ?? [],
    collapsedAt: input.collapsedAt ?? {},
    dockWidth: input.dockWidth ?? 1000,
  });
}

function settle(input: { pills: DockPillMeasure[]; availableWidth: number; dockWidth?: number }) {
  let collapsed: DockPillKey[] = [];
  let collapsedAt: Partial<Record<DockPillKey, number>> = {};
  for (let step = 0; step < 10; step++) {
    const next = plan({ ...input, collapsed, collapsedAt });
    if (next.collapsed.length === collapsed.length && next.collapsed.every((k, i) => collapsed[i] === k)) {
      return next;
    }
    collapsed = next.collapsed;
    collapsedAt = next.collapsedAt;
  }
  throw new Error('plan did not settle');
}

describe('dockTasksPillPriority', () => {
  it('ranks a running task above any timestamp', () => {
    expect(dockTasksPillPriority([{ state: 'run' }])).toBe(LIVE_PILL_PRIORITY);
    expect(dockTasksPillPriority([{ state: 'done', completedAt: '2026-09-17T10:00:00Z' }])).toBeLessThan(
      LIVE_PILL_PRIORITY,
    );
  });

  it('uses the most recent activity timestamp', () => {
    const priority = dockTasksPillPriority([
      { state: 'done', completedAt: '2026-09-16T10:00:00Z' },
      { state: 'done', completedAt: '2026-09-17T09:00:00Z' },
    ]);
    expect(priority).toBe(Date.parse('2026-09-17T09:00:00Z'));
  });

  it('falls back to zero without timestamps', () => {
    expect(dockTasksPillPriority([])).toBe(0);
    expect(dockTasksPillPriority([{ state: 'done' }])).toBe(0);
  });
});

describe('planDockPillCollapse', () => {
  it('keeps every pill expanded when they all fit', () => {
    const result = plan({
      pills: [pill('goal', 0), pill('bash', 1), pill('todos', 2)],
      availableWidth: 316,
    });
    expect(result.collapsed).toEqual([]);
  });

  it('collapses one pill per pass, least important first, until the rest fit', () => {
    const pills = [pill('goal', 0), pill('bash', 1), pill('todos', 2)];
    const first = plan({ pills, availableWidth: 200 });
    expect(first.collapsed).toEqual(['goal']);
    const second = plan({ pills, availableWidth: 200, collapsed: first.collapsed, collapsedAt: first.collapsedAt });
    expect(second.collapsed).toEqual(['goal', 'bash']);
    const third = plan({ pills, availableWidth: 200, collapsed: second.collapsed, collapsedAt: second.collapsedAt });
    expect(third.collapsed).toEqual(['goal', 'bash']);
  });

  it('collapses the rightmost pill first on equal priority', () => {
    const result = settle({
      pills: [pill('bash', LIVE_PILL_PRIORITY), pill('subagent', LIVE_PILL_PRIORITY)],
      availableWidth: 150,
    });
    expect(result.collapsed).toEqual(['subagent']);
  });

  it('collapses every pill when nothing fits', () => {
    const result = settle({
      pills: [pill('goal', 0), pill('bash', 1)],
      availableWidth: 40,
    });
    expect(result.collapsed).toEqual(['goal', 'bash']);
  });

  it('prefers a recently active pill over a stale one', () => {
    const result = settle({
      pills: [
        pill('bash', Date.parse('2026-09-16T10:00:00Z')),
        pill('subagent', Date.parse('2026-09-17T09:00:00Z')),
      ],
      availableWidth: 150,
    });
    expect(result.collapsed).toEqual(['bash']);
  });

  it('holds a collapsed pill until the dock grows past the expand margin', () => {
    const first = settle({
      pills: [pill('goal', 0), pill('bash', 1)],
      availableWidth: 150,
      dockWidth: 500,
    });
    expect(first.collapsed).toEqual(['goal']);

    const held = plan({
      pills: [pill('goal', 0), pill('bash', 1)],
      availableWidth: 400,
      dockWidth: 548,
      collapsed: first.collapsed,
      collapsedAt: first.collapsedAt,
    });
    expect(held.collapsed).toEqual(['goal']);

    const released = plan({
      pills: [pill('goal', 0), pill('bash', 1)],
      availableWidth: 400,
      dockWidth: 549,
      collapsed: first.collapsed,
      collapsedAt: first.collapsedAt,
    });
    expect(released.collapsed).toEqual([]);
  });
});
