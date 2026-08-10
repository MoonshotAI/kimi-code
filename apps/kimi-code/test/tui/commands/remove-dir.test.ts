import { describe, expect, it, vi } from 'vitest';

import { handleRemoveDirCommand } from '#/tui/commands/remove-dir';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

type MountedPanel = {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
};

function makeHost(additionalDirs: readonly string[] = ['/repo/shared']) {
  const state = {
    appState: { additionalDirs, streamingPhase: 'idle', isCompacting: false },
  };
  let mountedPanel: MountedPanel | null = null;
  const session = {
    id: 'session-1',
    summary: { additionalDirs },
    removeAdditionalDir: vi.fn(async (path: string, options: { forget: boolean }) => ({
      additionalDirs: additionalDirs.filter((dir) => dir !== path),
      projectRoot: '/repo',
      configPath: '/repo/.kimi-code/local.toml',
      forgotten: options.forget,
    })),
  };
  const host = {
    state,
    session,
    engineV2: false,
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(state.appState, patch)),
    refreshSlashCommandAutocomplete: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    mountEditorReplacement: vi.fn((panel: MountedPanel) => { mountedPanel = panel; }),
    restoreEditor: vi.fn(() => { mountedPanel = null; }),
  } as unknown as SlashCommandHost & {
    session: typeof session;
    state: typeof state;
    setAppState: ReturnType<typeof vi.fn>;
    refreshSlashCommandAutocomplete: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
  };
  return { host, session, getMountedPanel: () => mountedPanel };
}

describe('handleRemoveDirCommand', () => {
  it('shows the empty message when no additional dirs are configured', async () => {
    const { host } = makeHost([]);

    await handleRemoveDirCommand(host, '');

    expect(host.showStatus).toHaveBeenCalledWith('No additional directories configured.');
  });

  it('selects a configured root and removes a session-only directory', async () => {
    const { host, session, getMountedPanel } = makeHost(['/repo/shared', '/repo/docs']);

    await handleRemoveDirCommand(host, '');
    expect(getMountedPanel()?.render(120).join('\n')).toContain('/repo/shared');
    getMountedPanel()?.handleInput(' ');
    await vi.waitFor(() => {
      expect(getMountedPanel()?.render(120).join('\n')).toContain('Remove session-only directory');
    });
    getMountedPanel()?.handleInput(' ');

    await vi.waitFor(() => {
      expect(session.removeAdditionalDir).toHaveBeenCalledWith('/repo/shared', { forget: false });
    });
    expect(host.setAppState).toHaveBeenCalledWith({ additionalDirs: ['/repo/docs'] });
    expect(host.refreshSlashCommandAutocomplete).toHaveBeenCalledOnce();
  });

  it('removes and forgets an explicit directory after confirmation', async () => {
    const { host, session, getMountedPanel } = makeHost();

    await handleRemoveDirCommand(host, '/repo/shared');
    getMountedPanel()?.handleInput('\u001B[B');
    getMountedPanel()?.handleInput(' ');

    await vi.waitFor(() => {
      expect(session.removeAdditionalDir).toHaveBeenCalledWith('/repo/shared', { forget: true });
      expect(host.showStatus).toHaveBeenCalledWith(
        'Removed workspace directory:\n  /repo/shared\n  Removed from:\n  /repo/.kimi-code/local.toml',
        'success',
      );
    });
  });

  it('surfaces core validation errors without mutating app state', async () => {
    const { host, session, getMountedPanel } = makeHost();
    session.removeAdditionalDir.mockRejectedValueOnce(
      new Error('The primary workspace directory cannot be removed'),
    );

    await handleRemoveDirCommand(host, '/repo');
    getMountedPanel()?.handleInput(' ');

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(
        'The primary workspace directory cannot be removed',
      );
    });
    expect(host.setAppState).not.toHaveBeenCalled();
  });

  it('re-checks the busy gate after lazy session creation', async () => {
    const { host, session, getMountedPanel } = makeHost();
    Object.assign(host, {
      session: undefined,
      engineV2: true,
      ensureSession: vi.fn(async () => {
        host.state.appState.streamingPhase = 'waiting';
        return session;
      }),
    });

    await handleRemoveDirCommand(host, '/repo/shared');

    expect(host.showError).toHaveBeenCalledWith(
      'Cannot /remove-dir while streaming — press Esc or Ctrl-C first.',
    );
    expect(getMountedPanel()).toBeNull();
    expect(session.removeAdditionalDir).not.toHaveBeenCalled();
  });
});
