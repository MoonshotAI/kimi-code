import { describe, expect, it, vi } from 'vitest';

import type { CronTaskSnapshot } from '@moonshot-ai/kimi-code-sdk';

import { CronSelectorComponent } from '#/tui/components/dialogs/cron-selector';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function task(overrides: Partial<CronTaskSnapshot> = {}): CronTaskSnapshot {
  return {
    id: '01JTASK000000000000000000',
    cron: '*/8 * * * *',
    prompt: 'check the PR reviews',
    recurring: true,
    createdAt: Date.now(),
    lastFiredAt: undefined,
    nextFireAt: new Date('2026-08-16T18:40:00').getTime(),
    ...overrides,
  };
}

function makeSelector(tasks: readonly CronTaskSnapshot[]) {
  const onDelete = vi.fn();
  const onCancel = vi.fn();
  const component = new CronSelectorComponent({ tasks, onDelete, onCancel });
  return { component, onDelete, onCancel };
}

describe('CronSelectorComponent', () => {
  it('renders the header vocabulary and the task details', () => {
    const { component } = makeSelector([task()]);
    const lines = component.render(100).map(strip);

    const titleIdx = lines.findIndex((l) => l.includes('Scheduled cron tasks'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    const hint = lines[titleIdx + 1];
    expect(hint).toContain('↑↓ navigate');
    expect(hint).toContain('D delete');
    expect(hint).toContain('Esc cancel');

    expect(lines.some((l) => l.includes('❯ */8 * * * *'))).toBe(true);
    expect(lines.some((l) => l.includes('next 08-16 18:40'))).toBe(true);
    expect(lines.some((l) => l.includes('recurring · check the PR reviews'))).toBe(true);
  });

  it('marks one-shot tasks and tasks without a future fire', () => {
    const { component } = makeSelector([
      task({ recurring: false, nextFireAt: null }),
    ]);
    const lines = component.render(100).map(strip);

    expect(lines.some((l) => l.includes('no future fire'))).toBe(true);
    expect(lines.some((l) => l.includes('one-shot'))).toBe(true);
  });

  it('asks for confirmation before deleting', () => {
    const { component, onDelete } = makeSelector([task()]);

    component.handleInput('d');
    const lines = component.render(100).map(strip);
    expect(lines.some((l) => l.includes('[y/N]'))).toBe(true);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('deletes the selected task on y', () => {
    const tasks = [task(), task({ id: '01JOTHER00000000000000000', cron: '0 9 * * 1' })];
    const { component, onDelete } = makeSelector(tasks);

    component.handleInput('\u001B[B'); // ↓ to the second task
    component.handleInput('d');
    component.handleInput('y');

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0]?.[0].id).toBe('01JOTHER00000000000000000');
  });

  it('drops the pending confirmation on n', () => {
    const { component, onDelete } = makeSelector([task()]);

    component.handleInput('d');
    component.handleInput('n');
    const lines = component.render(100).map(strip);

    expect(onDelete).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('[y/N]'))).toBe(false);
  });

  it('cancels on escape', () => {
    const { component, onCancel } = makeSelector([task()]);

    component.handleInput('\u001B');

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders an explicit empty state', () => {
    const { component } = makeSelector([]);
    const lines = component.render(100).map(strip);

    expect(lines.some((l) => l.includes('No scheduled cron tasks'))).toBe(true);
  });

  it('strips terminal control sequences from the prompt preview', () => {
    const malicious = 'check reviews \u001B[2J\u001B[?25l also \u001B]8;;https://evil.example\u0007click\u001B]8;;\u0007 and bell\u0007';
    const { component } = makeSelector([task({ prompt: malicious })]);
    const raw = component.render(100).join('\n');

    // Only the component's own theme styling may carry ESC bytes; the prompt
    // text must contribute none of its control content.
    const lines = component.render(100).map(strip);
    expect(lines.some((l) => l.includes('check reviews'))).toBe(true);
    expect(raw).not.toContain('[2J');
    expect(raw).not.toContain('[?25l');
    expect(raw).not.toContain(']8;');
    expect(lines.some((l) => l.includes('evil.example'))).toBe(false);
  });
});
