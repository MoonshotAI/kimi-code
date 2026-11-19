import type { ConfirmOptions } from '@moonshot-ai/app-client/composables';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalCloseGuard } from '../../src/renderer/lib/terminalCloseGuard';
import type { TerminalActivity } from '../../src/shared/terminal-activity';

const t = (key: string): string => key;
const tab = (id: string) => ({ id, title: `Terminal ${id}`, ptyId: id });
const busy = (id: string): TerminalActivity => ({ id, state: 'busy', binary: 'node', cwd: '/work', processes: [{ binary: 'node', pid: 123 }] });

describe('terminal close confirmation', () => {
  it('combines running terminals into one confirmation and excludes idle or exited ones', async () => {
    const confirm = vi.fn<(options: ConfirmOptions) => Promise<boolean>>(async () => false);
    const inspect = vi.fn(async () => [busy('a'), { ...busy('b'), state: 'idle' as const }, busy('c')]);
    const approve = createTerminalCloseGuard({ t, inspect, confirm });
    expect(await approve([tab('a'), tab('b'), tab('c')])).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    const message = confirm.mock.calls[0]?.[0] as { message: string } | undefined;
    expect(message?.message).toContain('Terminal a\nnode (PID 123)\n/work');
    expect(message?.message).toContain('Terminal c');
    expect(message?.message).not.toContain('Terminal b');
  });

  it('closes idle terminals without confirmation but requires confirmation if inspection fails', async () => {
    const confirm = vi.fn(async () => true);
    const inspect = vi.fn<() => Promise<TerminalActivity[]>>().mockResolvedValueOnce([{ ...busy('a'), state: 'idle' }]).mockRejectedValueOnce(new Error('unavailable'));
    const approve = createTerminalCloseGuard({ t, inspect, confirm });
    expect(await approve([tab('a')])).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(await approve([tab('a')])).toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('terminal.closeUnknown') }));
  });

  it('does not open duplicate confirmations while a batch decision is pending', async () => {
    let finish!: (accepted: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const approve = createTerminalCloseGuard({ t, inspect: async () => [busy('a')], confirm });
    const first = approve([tab('a')]);
    await Promise.resolve();
    expect(await approve([tab('a')])).toBe(false);
    finish(true);
    expect(await first).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
