import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CronTaskSnapshot } from '@moonshot-ai/kimi-code-sdk';

import { handleCronCommand } from '#/tui/commands/cron';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/index';
import { CronSelectorComponent } from '#/tui/components/dialogs/cron-selector';

function task(overrides: Partial<CronTaskSnapshot> = {}): CronTaskSnapshot {
  return {
    id: '01JTASK000000000000000000',
    cron: '*/8 * * * *',
    prompt: 'check the PR reviews',
    recurring: true,
    createdAt: Date.now(),
    lastFiredAt: undefined,
    nextFireAt: Date.now() + 8 * 60_000,
    ...overrides,
  };
}

function makeHost(tasks: readonly CronTaskSnapshot[] | Error) {
  const session = {
    getCronTasks: vi.fn(async () => {
      if (tasks instanceof Error) throw tasks;
      return { tasks };
    }),
    deleteCronTask: vi.fn(async () => ({ deleted: true })),
  };
  const host = {
    session,
    showStatus: vi.fn(),
    showError: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
  } as unknown as SlashCommandHost & {
    session: typeof session;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
  };
  return host;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('cron slash command', () => {
  it('is registered as an always-available built-in', () => {
    const command = findBuiltInSlashCommand('cron');
    expect(command).toBeDefined();
    expect(resolveSlashCommandAvailability(command!, '')).toBe('always');
  });
});

describe('handleCronCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('errors when no session is active', async () => {
    const host = makeHost([]);
    (host as { session?: unknown }).session = undefined;

    await handleCronCommand(host);

    expect(host.showError).toHaveBeenCalledWith('No active session.');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('reports a status when no cron tasks are scheduled', async () => {
    const host = makeHost([]);

    await handleCronCommand(host);

    expect(host.showStatus).toHaveBeenCalledWith('No scheduled cron tasks.');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('shows an error when listing fails', async () => {
    const host = makeHost(new Error('rpc down'));

    await handleCronCommand(host);

    expect(host.showError).toHaveBeenCalledWith('Failed to load cron tasks: rpc down');
  });

  it('mounts the selector with the scheduled tasks', async () => {
    const tasks = [task()];
    const host = makeHost(tasks);

    await handleCronCommand(host);

    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    const component = host.mountEditorReplacement.mock.calls[0]?.[0];
    expect(component).toBeInstanceOf(CronSelectorComponent);
  });

  it('deletes the task through the session and restores the editor', async () => {
    const tasks = [task()];
    const host = makeHost(tasks);

    await handleCronCommand(host);
    const component = host.mountEditorReplacement.mock.calls[0]?.[0] as CronSelectorComponent;
    component.handleInput('d');
    component.handleInput('y');
    await flushMicrotasks();

    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.session.deleteCronTask).toHaveBeenCalledWith(tasks[0]!.id);
    expect(host.showStatus).toHaveBeenCalledWith(
      `Deleted cron task ${tasks[0]!.id} (*/8 * * * *).`,
      'success',
    );
  });

  it('reports when the task was already gone', async () => {
    const tasks = [task()];
    const host = makeHost(tasks);
    host.session.deleteCronTask.mockResolvedValue({ deleted: false });

    await handleCronCommand(host);
    const component = host.mountEditorReplacement.mock.calls[0]?.[0] as CronSelectorComponent;
    component.handleInput('d');
    component.handleInput('y');
    await flushMicrotasks();

    expect(host.showStatus).toHaveBeenCalledWith(
      `Cron task ${tasks[0]!.id} was already gone.`,
      'warning',
    );
  });

  it('shows an error when deletion fails', async () => {
    const tasks = [task()];
    const host = makeHost(tasks);
    host.session.deleteCronTask.mockRejectedValue(new Error('rpc down'));

    await handleCronCommand(host);
    const component = host.mountEditorReplacement.mock.calls[0]?.[0] as CronSelectorComponent;
    component.handleInput('d');
    component.handleInput('y');
    await flushMicrotasks();

    expect(host.showError).toHaveBeenCalledWith(
      `Failed to delete cron task ${tasks[0]!.id}: rpc down`,
    );
  });

  it('closes the selector without deleting on cancel', async () => {
    const host = makeHost([task()]);

    await handleCronCommand(host);
    const component = host.mountEditorReplacement.mock.calls[0]?.[0] as CronSelectorComponent;
    component.handleInput('\u001B');
    await flushMicrotasks();

    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.session.deleteCronTask).not.toHaveBeenCalled();
  });
});
