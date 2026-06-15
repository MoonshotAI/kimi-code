import { describe, expect, it, vi } from 'vitest';

import { handleUpgrade } from '#/cli/sub/upgrade';
import type { InstallPromptChoiceValue } from '#/cli/update/prompt';
import type { InstallSource, UpdateCache } from '#/cli/update/types';

function cacheWith(
  version: string | null,
  manifest: UpdateCache['manifest'] = null,
): UpdateCache {
  return {
    source: 'cdn',
    checkedAt: '2026-04-23T08:00:00.000Z',
    latest: version,
    manifest,
  };
}

function captureOutput(): {
  stdout: string[];
  stderr: string[];
  writable: {
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writable: {
      stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
      stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
    },
  };
}

function createDeps(overrides: {
  readonly latest?: string | null;
  readonly manifest?: UpdateCache['manifest'];
  readonly source?: InstallSource;
  readonly isInteractive?: boolean;
  readonly promptForInstallChoice?: () => Promise<InstallPromptChoiceValue>;
  readonly installUpdate?: (source: InstallSource, version: string, platform: NodeJS.Platform) => Promise<void>;
} = {}) {
  const installUpdate =
    overrides.installUpdate ??
    vi.fn<(
      source: InstallSource,
      version: string,
      platform: NodeJS.Platform,
    ) => Promise<void>>().mockResolvedValue(undefined);

  return {
    refreshUpdateCache: vi
      .fn()
      .mockResolvedValue(cacheWith(overrides.latest ?? '0.5.0', overrides.manifest ?? null)),
    detectInstallSource: vi.fn().mockResolvedValue(overrides.source ?? 'npm-global'),
    promptForInstallChoice:
      overrides.promptForInstallChoice ?? vi.fn().mockResolvedValue('install'),
    installUpdate,
    track: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    platform: 'darwin' as NodeJS.Platform,
    isInteractive: overrides.isInteractive ?? true,
  };
}

describe('handleUpgrade', () => {
  it('prompts before installing the latest version when the install source supports it', async () => {
    const { stdout, stderr, writable } = captureOutput();
    const deps = createDeps({ latest: '0.5.0', source: 'npm-global' });

    await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(deps.detectInstallSource).toHaveBeenCalledTimes(1);
    expect(deps.promptForInstallChoice).toHaveBeenCalledWith({
      currentVersion: '0.4.0',
      target: { version: '0.5.0' },
      installCommand: 'npm install -g @moonshot-ai/kimi-code@0.5.0',
      installSource: 'npm-global',
    });
    expect(deps.installUpdate).toHaveBeenCalledWith('npm-global', '0.5.0', 'darwin');
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_prompted', expect.objectContaining({
      current_version: '0.4.0',
      target_version: '0.5.0',
      source: 'npm-global',
    }));
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_install_selected', expect.objectContaining({
      target_version: '0.5.0',
      source: 'npm-global',
    }));
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_succeeded', expect.objectContaining({
      target_version: '0.5.0',
      source: 'npm-global',
    }));
    expect(deps.logger.info).toHaveBeenCalledWith('manual upgrade install succeeded', expect.objectContaining({
      targetVersion: '0.5.0',
      source: 'npm-global',
    }));
    expect(stdout.join('')).toContain('Updated @moonshot-ai/kimi-code to 0.5.0');
    expect(stderr.join('')).toBe('');
  });

  it('skips the foreground install when the update prompt is declined', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({
      latest: '0.5.0',
      source: 'npm-global',
      promptForInstallChoice: vi.fn().mockResolvedValue('skip'),
    });

    await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.promptForInstallChoice).toHaveBeenCalledTimes(1);
    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_skipped', expect.objectContaining({
      target_version: '0.5.0',
      source: 'npm-global',
    }));
    expect(stdout.join('')).toBe('');
  });

  it('prints up-to-date status without detecting the install source when no newer version exists', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({ latest: '0.4.0' });

    await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.detectInstallSource).not.toHaveBeenCalled();
    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_no_update', expect.objectContaining({
      current_version: '0.4.0',
    }));
    expect(stdout.join('')).toContain('Kimi Code is already up to date (v0.4.0).');
  });

  it('prints the manual update command when the install source cannot be auto-installed', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({ latest: '0.5.0', source: 'unsupported' });

    await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.promptForInstallChoice).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_manual_command', expect.objectContaining({
      target_version: '0.5.0',
      source: 'unsupported',
    }));
    expect(stdout.join('')).toContain('To update manually, run: npm install -g @moonshot-ai/kimi-code@0.5.0');
  });

  it('prints the manual update command without prompting when not interactive', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({ latest: '0.5.0', source: 'npm-global', isInteractive: false });

    await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.promptForInstallChoice).not.toHaveBeenCalled();
    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_manual_command', expect.objectContaining({
      target_version: '0.5.0',
      source: 'npm-global',
    }));
    expect(stdout.join('')).toContain('To update manually, run: npm install -g @moonshot-ai/kimi-code@0.5.0');
  });

  it('returns a failing exit code when the foreground install fails', async () => {
    const { stderr, writable } = captureOutput();
    const deps = createDeps({
      latest: '0.5.0',
      source: 'npm-global',
      installUpdate: vi.fn().mockRejectedValue(new Error('npm exited with code 1')),
    });

    await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(1);

    expect(stderr.join('')).toContain(
      'warning: failed to install @moonshot-ai/kimi-code@0.5.0: npm exited with code 1',
    );
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_failed', expect.objectContaining({
      target_version: '0.5.0',
      source: 'npm-global',
      stage: 'install',
    }));
    expect(deps.logger.warn).toHaveBeenCalledWith('manual upgrade install failed', expect.objectContaining({
      targetVersion: '0.5.0',
      source: 'npm-global',
    }));
  });

  it('returns a failing exit code when checking the latest version fails', async () => {
    const { stderr, writable } = captureOutput();
    const deps = {
      ...createDeps(),
      refreshUpdateCache: vi.fn().mockRejectedValue(new Error('cdn unavailable')),
    };

    await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(1);

    expect(deps.detectInstallSource).not.toHaveBeenCalled();
    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_failed', expect.objectContaining({
      current_version: '0.4.0',
      stage: 'refresh',
    }));
    expect(stderr.join('')).toContain('error: failed to check for updates: cdn unavailable');
  });

  it('ignores rollout gating: installs the latest version while every batch is still held', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({
      latest: '0.5.0',
      // Published seconds ago with every device delayed by 24h — passive
      // update surfaces would hide this version, manual upgrade must not.
      manifest: {
        version: '0.5.0',
        publishedAt: new Date(Date.now() - 1_000).toISOString(),
        rollout: [{ percent: 100, delaySeconds: 86_400 }],
      },
    });

    await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.installUpdate).toHaveBeenCalledWith('npm-global', '0.5.0', 'darwin');
    expect(stdout.join('')).toContain('Updated @moonshot-ai/kimi-code to 0.5.0');
  });
});
