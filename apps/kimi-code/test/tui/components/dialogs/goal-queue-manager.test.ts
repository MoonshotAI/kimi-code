import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import {
  GoalQueueEditDialogComponent,
  GoalQueueManagerComponent,
  type GoalQueueManagerAction,
} from '#/tui/components/dialogs/goal-queue-manager';
import type { GoalQueueSnapshot, UpcomingGoal } from '#/tui/goal-queue-store';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const CTRL_J = '\u001B[106;5u';
const BRACKET_PASTE_START = '\u001B[200~';
const BRACKET_PASTE_END = '\u001B[201~';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;

function goal(id: string, objective: string): UpcomingGoal {
  return {
    id,
    objective,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
  };
}

function snapshot(goals: readonly UpcomingGoal[]): GoalQueueSnapshot {
  return { goals };
}

function text(component: GoalQueueManagerComponent | GoalQueueEditDialogComponent, width = 100) {
  return component.render(width).map(strip).join('\n');
}

describe('GoalQueueManagerComponent', () => {
  it('renders the upcoming goals and the management hint', () => {
    const manager = new GoalQueueManagerComponent({
      goals: [goal('g1', 'Ship queued goal')],
      onAction: vi.fn(),
      onCancel: vi.fn(),
    });

    const out = text(manager);
    expect(out).toContain('Upcoming goals');
    expect(out).toContain('↑↓ navigate · Space select · E edit · D delete · Esc cancel');
    expect(out).toContain('❯ 1. Ship queued goal');
  });

  it('uses Space to enter move mode and reorders with Up/Down', async () => {
    const first = goal('g1', 'First queued goal');
    const second = goal('g2', 'Second queued goal');
    const onAction = vi.fn(async (action: GoalQueueManagerAction) => {
      expect(action).toEqual({ kind: 'move', goalId: 'g2', direction: 'up' });
      return snapshot([second, first]);
    });
    const manager = new GoalQueueManagerComponent({
      goals: [first, second],
      onAction,
      onCancel: vi.fn(),
    });

    manager.handleInput(DOWN);
    manager.handleInput(' ');
    expect(text(manager)).toContain('↑↓ reorder · Space done · E edit · D delete · Esc cancel');
    manager.handleInput(UP);

    await vi.waitFor(() => {
      expect(onAction).toHaveBeenCalledOnce();
    });
    const out = text(manager);
    expect(out.indexOf('Second queued goal')).toBeLessThan(out.indexOf('First queued goal'));
  });

  it('deletes the selected goal and keeps the list open', async () => {
    const first = goal('g1', 'First queued goal');
    const second = goal('g2', 'Second queued goal');
    const onAction = vi.fn(async (action: GoalQueueManagerAction) => {
      expect(action).toEqual({ kind: 'delete', goalId: 'g1' });
      return snapshot([second]);
    });
    const manager = new GoalQueueManagerComponent({
      goals: [first, second],
      onAction,
      onCancel: vi.fn(),
    });

    manager.handleInput('d');

    await vi.waitFor(() => {
      expect(onAction).toHaveBeenCalledOnce();
    });
    const out = text(manager);
    expect(out).not.toContain('First queued goal');
    expect(out).toContain('1. Second queued goal');
  });

  it('invalidates after an async queue action updates the list', async () => {
    const first = goal('g1', 'First queued goal');
    const second = goal('g2', 'Second queued goal');
    let resolveAction: (value: GoalQueueSnapshot) => void;
    const onAction = vi.fn(
      () =>
        new Promise<GoalQueueSnapshot>((resolve) => {
          resolveAction = resolve;
        }),
    );
    const manager = new GoalQueueManagerComponent({
      goals: [first, second],
      onAction,
      onCancel: vi.fn(),
    });
    const invalidate = vi.spyOn(manager, 'invalidate');

    manager.handleInput('d');
    resolveAction!(snapshot([second]));

    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
  });

  it('emits an edit action for the selected goal', () => {
    const onAction = vi.fn();
    const manager = new GoalQueueManagerComponent({
      goals: [goal('g1', 'First queued goal')],
      onAction,
      onCancel: vi.fn(),
    });

    manager.handleInput('e');

    expect(onAction).toHaveBeenCalledWith({ kind: 'edit', goalId: 'g1' });
  });

  it('cancels with Esc', () => {
    const onCancel = vi.fn();
    const manager = new GoalQueueManagerComponent({
      goals: [],
      onAction: vi.fn(),
      onCancel,
    });

    manager.handleInput(ESC);

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('never renders a line wider than the terminal', () => {
    const manager = new GoalQueueManagerComponent({
      goals: [goal('g1', 'A very long queued goal objective that should be truncated cleanly')],
      onAction: vi.fn(),
      onCancel: vi.fn(),
    });

    for (const width of [24, 40, 80]) {
      for (const line of manager.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('renders multiline objectives as a single selectable row', () => {
    const manager = new GoalQueueManagerComponent({
      goals: [goal('g1', 'First line\nSecond line')],
      onAction: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = manager.render(100).map(strip);

    expect(lines.some((line) => line.includes('❯ 1. First line Second line'))).toBe(true);
    expect(lines.some((line) => line.trim() === 'Second line')).toBe(false);
  });
});

describe('GoalQueueEditDialogComponent', () => {
  it('submits the edited objective', () => {
    const onDone = vi.fn();
    const dialog = new GoalQueueEditDialogComponent({
      goal: goal('g1', 'Ship queued goal'),
      onDone,
    });

    dialog.handleInput(' safely');
    dialog.handleInput('\r');

    expect(onDone).toHaveBeenCalledWith({
      kind: 'save',
      goalId: 'g1',
      objective: 'Ship queued goal safely',
    });
  });

  it('supports multiline objective edits', () => {
    const onDone = vi.fn();
    const dialog = new GoalQueueEditDialogComponent({
      goal: goal('g1', 'Ship queued goal'),
      onDone,
    });

    dialog.handleInput(CTRL_J);
    dialog.handleInput('with a second line');
    dialog.handleInput('\r');

    expect(onDone).toHaveBeenCalledWith({
      kind: 'save',
      goalId: 'g1',
      objective: 'Ship queued goal\nwith a second line',
    });
  });

  it('sanitizes bracketed paste while preserving newlines', () => {
    const onDone = vi.fn();
    const dialog = new GoalQueueEditDialogComponent({
      goal: goal('g1', 'Ship queued goal'),
      onDone,
    });

    dialog.handleInput(
      `${BRACKET_PASTE_START} \u001B[31mred\u001B[0m\nnext\u0007 line${BRACKET_PASTE_END}`,
    );
    dialog.handleInput('\r');

    expect(onDone).toHaveBeenCalledWith({
      kind: 'save',
      goalId: 'g1',
      objective: 'Ship queued goal red\nnext line',
    });
  });

  it('renders multiline edits inside the dialog width', () => {
    const dialog = new GoalQueueEditDialogComponent({
      goal: goal('g1', 'First line\nSecond line'),
      onDone: vi.fn(),
    });

    const out = text(dialog, 36);

    expect(out).toContain('> First line');
    expect(out).toContain('  Second line');
    for (const line of dialog.render(36)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(36);
    }
  });

  it('keeps the edit dialog within narrow widths', () => {
    const dialog = new GoalQueueEditDialogComponent({
      goal: goal('g1', 'A very long queued objective for width testing'),
      onDone: vi.fn(),
    });

    for (const width of [24, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('keeps accepting input after save returns control to the mounted dialog', () => {
    const onDone = vi.fn();
    const dialog = new GoalQueueEditDialogComponent({
      goal: goal('g1', 'Ship queued goal'),
      onDone,
    });

    dialog.handleInput('\r');
    dialog.handleInput(ESC);

    expect(onDone).toHaveBeenLastCalledWith({ kind: 'cancel', goalId: 'g1' });
  });

  it('shows an empty objective hint instead of submitting', () => {
    const onDone = vi.fn();
    const dialog = new GoalQueueEditDialogComponent({
      goal: goal('g1', ''),
      onDone,
    });

    dialog.handleInput('\r');

    expect(onDone).not.toHaveBeenCalled();
    expect(text(dialog)).toContain('Goal objective cannot be empty.');
  });
});
