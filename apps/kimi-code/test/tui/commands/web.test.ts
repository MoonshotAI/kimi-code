import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleWebCommand, webSessionUrl } from '#/tui/commands/web';

const mocks = vi.hoisted(() => ({
  getLiveServerInstance: vi.fn(),
  isServerHealthy: vi.fn(),
  tryResolveServerToken: vi.fn(),
  getDataDir: vi.fn(() => '/tmp/kimi-home'),
  openUrl: vi.fn(),
}));

vi.mock('@moonshot-ai/kap-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kap-server')>();
  return { ...actual, getLiveServerInstance: mocks.getLiveServerInstance };
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
    stop: vi.fn(async () => {}),
  } as unknown as SlashCommandHost & {
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    setExitOpenUrl: ReturnType<typeof vi.fn>;
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
    mocks.getLiveServerInstance.mockResolvedValue({
      serverId: 'srv-1',
      pid: 1234,
      host: '127.0.0.1',
      port: 58627,
      startedAt: 1,
      heartbeatAt: 1,
    });
    mocks.isServerHealthy.mockResolvedValue(true);
  });

  it('shows the token in green and opens the deep link carrying the token fragment', async () => {
    mocks.tryResolveServerToken.mockReturnValue('tok-1');
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
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

  it('shows an error and does not exit when no server is running', async () => {
    mocks.getLiveServerInstance.mockResolvedValue(undefined);
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    getMountedPanel()?.handleInput('\r');
    await pending;

    expect(host.showError).toHaveBeenCalledWith(
      'No running Kimi server. Start one with `kimi web` in another terminal first.',
    );
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
  });

  it('shows an error and does not exit when the running server is unhealthy', async () => {
    mocks.isServerHealthy.mockResolvedValue(false);
    const { host, getMountedPanel } = makeHost();

    const pending = handleWebCommand(host);
    getMountedPanel()?.handleInput('\r');
    await pending;

    expect(host.showError).toHaveBeenCalledWith(
      'Kimi server at http://127.0.0.1:58627 is not responding.',
    );
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
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
