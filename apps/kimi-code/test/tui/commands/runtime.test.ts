import { describe, expect, it, vi } from 'vitest';

import { handleRuntimeCommand } from '#/tui/commands/runtime';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function host(session: {
  getRuntime(): Promise<{ workspaceId: string; runtimeId: string }>;
  switchRuntime(runtimeId: string): Promise<{ workspaceId: string; runtimeId: string }>;
}) {
  return {
    ensureSession: vi.fn().mockResolvedValue(session),
    showStatus: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost;
}

describe('handleRuntimeCommand', () => {
  it('shows the current runtime without switching', async () => {
    const session = {
      getRuntime: vi.fn().mockResolvedValue({ workspaceId: 'workspace', runtimeId: 'local' }),
      switchRuntime: vi.fn(),
    };
    const commandHost = host(session);

    await handleRuntimeCommand(commandHost, '');

    expect(session.getRuntime).toHaveBeenCalledOnce();
    expect(session.switchRuntime).not.toHaveBeenCalled();
    expect(commandHost.showStatus).toHaveBeenCalledWith('Runtime: local');
  });

  it('switches through the Session facade', async () => {
    const session = {
      getRuntime: vi.fn(),
      switchRuntime: vi.fn().mockResolvedValue({ workspaceId: 'workspace', runtimeId: 'remote' }),
    };
    const commandHost = host(session);

    await handleRuntimeCommand(commandHost, ' remote ');

    expect(session.switchRuntime).toHaveBeenCalledWith('remote');
    expect(commandHost.showStatus).toHaveBeenCalledWith('Runtime: remote');
  });
});
