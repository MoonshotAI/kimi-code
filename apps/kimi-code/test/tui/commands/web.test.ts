import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getVersion } from '#/cli/version';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleWebCommand, webSessionUrl } from '#/tui/commands/web';

const mocks = vi.hoisted(() => ({
  listLiveServerInstances: vi.fn(),
  startServerForeground: vi.fn(),
  isServerHealthy: vi.fn(),
  tryResolveServerToken: vi.fn(),
  getDataDir: vi.fn(() => '/tmp/kimi-home'),
  openUrl: vi.fn(),
}));

vi.mock('@moonshot-ai/kap-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kap-server')>();
  return { ...actual, listLiveServerInstances: mocks.listLiveServerInstances };
});

vi.mock('#/cli/sub/web/run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/sub/web/run')>();
  return { ...actual, startServerForeground: mocks.startServerForeground };
});

vi.mock('#/cli/sub/web/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/sub/web/shared')>();
  return {
    ...actual,
    isServerHealthy: mocks.isServerHealthy,
    tryResolveServerToken: mocks.tryResolveServerToken,
  };
});

vi.mock('#/utils/open-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/open-url')>();
  return { ...actual, openUrl: mocks.openUrl };
});

vi.mock('#/utils/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/paths')>();
  return { ...actual, getDataDir: mocks.getDataDir };
});

type MountedPanel = {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
};

const INSTANCE_SRV_1 = {
  serverId: 'srv-1',
  pid: 1234,
  host: '127.0.0.1',
  port: 58627,
  startedAt: 1,
  heartbeatAt: 1,
};

function makeHost() {
  let mountedPanel: MountedPanel | null = null;
  const host = {
    session: { id: 'ses-1' },
    showStatus: vi.fn(),
    showError: vi.fn(),
    mountEditorReplacement: vi.fn((panel: MountedPanel) => {
      mountedPanel = panel;
    }),
    restoreEditor: vi.fn(),
    setExitOpenUrl: vi.fn(),
    setExitForegroundTask: vi.fn(),
    stop: vi.fn(async () => {}),
  } as unknown as SlashCommandHost & {
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    setExitOpenUrl: ReturnType<typeof vi.fn>;
    setExitForegroundTask: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  return { host, getMountedPanel: () => mountedPanel };
}

describe('web slash command', () => {
  it('is registered as an always-available built-in', () => {
    const command = findBuiltInSlashCommand('web');
    expect(command).toBeDefined();
    expect(resolveSlashCommandAvailability(command!, '')).toBe('always');
  });
});

describe('handleWebCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDataDir.mockReturnValue('/tmp/kimi-home');
    mocks.listLiveServerInstances.mockResolvedValue([INSTANCE_SRV_1]);
    mocks.isServerHealthy.mockResolvedValue(true);
  });

  it('shows the token in green and opens the deep link carrying the token fragment', async () => {
    mocks.tryResolveServerToken.mockReturnValue('tok-1');
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    await vi.waitFor(() => {
      expect(getMountedPanel()).not.toBeNull();
    });
    getMountedPanel()?.handleInput('\r');
    await pending;

    expect(host.showStatus).toHaveBeenCalledWith(
      'open http://127.0.0.1:58627/sessions/ses-1#token=tok-1',
      'success',
    );
    expect(host.showStatus).toHaveBeenCalledWith('Token:    tok-1', 'success');
    expect(mocks.openUrl).toHaveBeenCalledWith(
      'http://127.0.0.1:58627/sessions/ses-1#token=tok-1',
    );
    expect(host.setExitOpenUrl).toHaveBeenCalledWith(
      'http://127.0.0.1:58627/sessions/ses-1#token=tok-1',
    );
    expect(host.stop).toHaveBeenCalledOnce();
  });

  it('skips the token line and fragment when no token is available', async () => {
    mocks.tryResolveServerToken.mockReturnValue(undefined);
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    await vi.waitFor(() => {
      expect(getMountedPanel()).not.toBeNull();
    });
    getMountedPanel()?.handleInput('\r');
    await pending;

    expect(host.showStatus).toHaveBeenCalledWith(
      'open http://127.0.0.1:58627/sessions/ses-1',
      'success',
    );
    expect(host.showStatus).not.toHaveBeenCalledWith(expect.stringContaining('Token:'), 'success');
    expect(mocks.openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627/sessions/ses-1');
    expect(host.setExitOpenUrl).toHaveBeenCalledWith('http://127.0.0.1:58627/sessions/ses-1');
  });

  it('opens the second instance when the user moves the cursor to it', async () => {
    mocks.tryResolveServerToken.mockReturnValue(undefined);
    mocks.listLiveServerInstances.mockResolvedValue([
      INSTANCE_SRV_1,
      { ...INSTANCE_SRV_1, serverId: 'srv-2', port: 58628 },
    ]);
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    await vi.waitFor(() => {
      expect(getMountedPanel()).not.toBeNull();
    });
    getMountedPanel()?.handleInput('\u001B[B');
    getMountedPanel()?.handleInput('\r');
    await pending;

    expect(mocks.isServerHealthy).toHaveBeenCalledWith('http://127.0.0.1:58628', expect.any(Number));
    expect(mocks.openUrl).toHaveBeenCalledWith('http://127.0.0.1:58628/sessions/ses-1');
    expect(host.stop).toHaveBeenCalledOnce();
  });

  it('lists each instance with its version, flagging a CLI mismatch', async () => {
    mocks.listLiveServerInstances.mockResolvedValue([
      { ...INSTANCE_SRV_1, hostVersion: '0.0.1-outdated' },
    ]);
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    await vi.waitFor(() => {
      expect(getMountedPanel()).not.toBeNull();
    });
    const lines = getMountedPanel()!.render(80).join('\n');
    getMountedPanel()?.handleInput('\u001B');
    await pending;

    expect(lines).toContain('http://127.0.0.1:58627');
    expect(lines).toContain(`version 0.0.1-outdated (this CLI: ${getVersion()})`);
    expect(lines).toContain('Start a new server');
  });

  it('shows an error and does not exit when the chosen server is unhealthy', async () => {
    mocks.isServerHealthy.mockResolvedValue(false);
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    await vi.waitFor(() => {
      expect(getMountedPanel()).not.toBeNull();
    });
    getMountedPanel()?.handleInput('\r');
    await pending;

    expect(host.showError).toHaveBeenCalledWith(
      'Kimi server at http://127.0.0.1:58627 is not responding.',
    );
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
  });

  it('does nothing on cancel', async () => {
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    await vi.waitFor(() => {
      expect(getMountedPanel()).not.toBeNull();
    });
    getMountedPanel()?.handleInput('\u001B');
    await pending;

    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(host.setExitForegroundTask).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
  });

  it('registers a foreground takeover when the user picks "Start a new server"', async () => {
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    await vi.waitFor(() => {
      expect(getMountedPanel()).not.toBeNull();
    });
    // One instance row, then "Start a new server".
    getMountedPanel()?.handleInput('\u001B[B');
    getMountedPanel()?.handleInput('\r');
    await pending;

    expect(host.setExitForegroundTask).toHaveBeenCalledOnce();
    expect(host.stop).toHaveBeenCalledOnce();
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.isServerHealthy).not.toHaveBeenCalled();
  });

  it('starts a new server directly when no instance is running, opening the deep link on ready', async () => {
    mocks.listLiveServerInstances.mockResolvedValue([]);
    mocks.tryResolveServerToken.mockReturnValue('tok-1');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.startServerForeground.mockImplementation(
      async (_options: unknown, hooks: { onReady?: (origin: string) => void }) => {
        hooks.onReady?.('http://127.0.0.1:58627');
      },
    );
    const { host, getMountedPanel } = makeHost();

    await handleWebCommand(host);

    // No picker: the takeover is registered and the TUI stops right away.
    expect(getMountedPanel()).toBeNull();
    expect(host.setExitForegroundTask).toHaveBeenCalledOnce();
    expect(host.stop).toHaveBeenCalledOnce();
    expect(mocks.openUrl).not.toHaveBeenCalled();

    const task = host.setExitForegroundTask.mock.calls[0]![0] as (
      exitCode: number,
    ) => Promise<void>;
    await task(0);

    expect(mocks.startServerForeground).toHaveBeenCalledOnce();
    expect(mocks.openUrl).toHaveBeenCalledWith(
      'http://127.0.0.1:58627/sessions/ses-1#token=tok-1',
    );
    const written = writeSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('Kimi server ready');
    expect(written).toContain('Ctrl+C');
    expect(written).toContain('/sessions/ses-1');
    writeSpy.mockRestore();
  });
});

describe('webSessionUrl', () => {
  it('deep-links to the session under the origin', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'abc123')).toBe(
      'http://127.0.0.1:58627/sessions/abc123',
    );
  });

  it('strips a trailing slash from the origin', () => {
    expect(webSessionUrl('http://127.0.0.1:58627/', 'abc123')).toBe(
      'http://127.0.0.1:58627/sessions/abc123',
    );
  });

  it('encodes session ids so the web UI can decode them', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'a/b c')).toBe(
      'http://127.0.0.1:58627/sessions/a%2Fb%20c',
    );
  });

  it('carries the bearer token in the fragment so the browser authenticates on load', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'abc123', 'tok-1')).toBe(
      'http://127.0.0.1:58627/sessions/abc123#token=tok-1',
    );
  });

  it('omits the fragment when no token is available', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'abc123', undefined)).toBe(
      'http://127.0.0.1:58627/sessions/abc123',
    );
  });
});
