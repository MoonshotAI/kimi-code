import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import type { TUI } from '@earendil-works/pi-tui';
import { runShellCommand } from '#/tui/utils/shell-executor';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_prompt: string, cb: () => void) => {
      cb();
    }),
    close: vi.fn(),
  })),
}));

function makeMockTUI(): TUI {
  return {
    stop: vi.fn(),
    start: vi.fn(),
    requestRender: vi.fn(),
  } as unknown as TUI;
}

describe('runShellCommand', () => {
  it('stops TUI, spawns command with inherited stdio, then restarts TUI', async () => {
    const ui = makeMockTUI();
    const mockChild = {
      on: vi.fn((event: string, cb: (arg?: number) => void) => {
        if (event === 'exit') cb(0);
      }),
    };
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);

    const code = await runShellCommand('echo hello', ui);

    expect(ui.stop).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith('echo hello', { shell: true, stdio: 'inherit' });
    expect(code).toBe(0);
    expect(ui.start).toHaveBeenCalledOnce();
    expect(ui.requestRender).toHaveBeenCalledWith(true);
  });

  it('restarts TUI even when spawn throws', async () => {
    const ui = makeMockTUI();
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('spawn failed');
    });

    await expect(runShellCommand('bad-cmd', ui)).rejects.toThrow('spawn failed');

    expect(ui.stop).toHaveBeenCalledOnce();
    expect(ui.start).toHaveBeenCalledOnce();
    expect(ui.requestRender).toHaveBeenCalledWith(true);
  });

  it('returns 128 + signum when process is killed by signal', async () => {
    const ui = makeMockTUI();
    const mockChild = {
      on: vi.fn((event: string, cb: (code: number | null, signal: string | null) => void) => {
        if (event === 'exit') cb(null, 'SIGTERM');
      }),
    };
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);

    const code = await runShellCommand('sleep 10', ui);

    expect(code).toBe(143); // 128 + 15 (SIGTERM)
  });
});
