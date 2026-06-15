import { describe, expect, it, vi } from 'vitest';

import { handleCheckUpdateCommand, handleUpdateCommand } from '#/tui/commands/update';

const mocks = vi.hoisted(() => ({
  refreshUpdateCache: vi.fn(),
  selectUpdateTarget: vi.fn(),
  detectInstallSource: vi.fn(),
  installCommandFor: vi.fn(),
  canAutoInstall: vi.fn(),
  renderManualUpdateMessage: vi.fn(),
}));

vi.mock('../../../src/cli/update/refresh', async () => ({
  refreshUpdateCache: mocks.refreshUpdateCache,
}));

vi.mock('../../../src/cli/update/select', async () => ({
  selectUpdateTarget: mocks.selectUpdateTarget,
}));

vi.mock('../../../src/cli/update/source', async () => ({
  detectInstallSource: mocks.detectInstallSource,
}));

vi.mock('../../../src/cli/update/preflight', async () => ({
  installCommandFor: mocks.installCommandFor,
  canAutoInstall: mocks.canAutoInstall,
  renderManualUpdateMessage: mocks.renderManualUpdateMessage,
}));

function createMockHost(overrides: Record<string, unknown> = {}): Parameters<typeof handleCheckUpdateCommand>[0] {
  return {
    state: { appState: { version: '1.0.0' } },
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    ...overrides,
  } as unknown as Parameters<typeof handleCheckUpdateCommand>[0];
}

describe('handleCheckUpdateCommand', () => {
  it('shows status when already up to date', async () => {
    mocks.refreshUpdateCache.mockResolvedValue({ latest: '1.0.0', checkedAt: '', source: 'cdn' });
    mocks.selectUpdateTarget.mockReturnValue(null);

    const host = createMockHost();
    await handleCheckUpdateCommand(host);

    expect(host.showStatus).toHaveBeenCalledWith('Kimi Code is already up to date (v1.0.0).');
  });

  it('shows notice when update is available', async () => {
    mocks.refreshUpdateCache.mockResolvedValue({ latest: '1.1.0', checkedAt: '', source: 'cdn' });
    mocks.selectUpdateTarget.mockReturnValue({ version: '1.1.0', changelogUrl: '' });

    const host = createMockHost();
    await handleCheckUpdateCommand(host);

    expect(host.showNotice).toHaveBeenCalledWith(
      'Update Available',
      expect.stringContaining('1.1.0'),
    );
  });

  it('shows error when refresh fails', async () => {
    mocks.refreshUpdateCache.mockRejectedValue(new Error('network error'));

    const host = createMockHost();
    await handleCheckUpdateCommand(host);

    expect(host.showError).toHaveBeenCalledWith('Failed to check for updates: network error');
  });
});

describe('handleUpdateCommand', () => {
  it('shows status when already up to date', async () => {
    mocks.refreshUpdateCache.mockResolvedValue({ latest: '1.0.0', checkedAt: '', source: 'cdn' });
    mocks.selectUpdateTarget.mockReturnValue(null);

    const host = createMockHost();
    await handleUpdateCommand(host);

    expect(host.showStatus).toHaveBeenCalledWith('Kimi Code is already up to date (v1.0.0).');
  });

  it('shows manual update notice for unsupported sources', async () => {
    mocks.refreshUpdateCache.mockResolvedValue({ latest: '1.1.0', checkedAt: '', source: 'cdn' });
    mocks.selectUpdateTarget.mockReturnValue({ version: '1.1.0', changelogUrl: '' });
    mocks.detectInstallSource.mockResolvedValue('unsupported');
    mocks.canAutoInstall.mockReturnValue(false);
    mocks.renderManualUpdateMessage.mockReturnValue('manual update message');

    const host = createMockHost();
    await handleUpdateCommand(host);

    expect(host.showNotice).toHaveBeenCalledWith('Manual Update Required', 'manual update message');
  });

  it('shows update prompt for auto-installable sources', async () => {
    mocks.refreshUpdateCache.mockResolvedValue({ latest: '1.1.0', checkedAt: '', source: 'cdn' });
    mocks.selectUpdateTarget.mockReturnValue({ version: '1.1.0', changelogUrl: '' });
    mocks.detectInstallSource.mockResolvedValue('npm');
    mocks.canAutoInstall.mockReturnValue(true);
    mocks.installCommandFor.mockReturnValue('npm install -g @moonshot-ai/kimi-code@1.1.0');

    const host = createMockHost();
    await handleUpdateCommand(host);

    expect(host.showNotice).toHaveBeenCalledWith(
      'Update Ready',
      expect.stringContaining('npm install -g @moonshot-ai/kimi-code@1.1.0'),
    );
  });
});
