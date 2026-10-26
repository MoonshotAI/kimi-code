import { describe, expect, it, vi } from 'vitest';

import { handleUpgrade } from '#/cli/sub/upgrade';
import type { InstallPromptChoiceValue } from '#/cli/update/prompt';
import type {
  ActionableUpdatePlan,
  InstallSource,
  UpdateCache,
  UpdateChannel,
} from '#/cli/update/types';

const DEV = '2.5.0-dev.202610260043';
const NEXT_DEV = '2.5.0-dev.202610270043';
const FIXED_DEV = '0.0.0-dev.42';

function upgradePlan(channel: UpdateChannel, version: string): ActionableUpdatePlan {
  return { kind: 'upgrade', target: { channel, version } };
}

function switchPlan(
  sourceChannel: UpdateChannel,
  targetChannel: UpdateChannel,
  version: string,
): ActionableUpdatePlan {
  return {
    kind: 'switch-channel',
    sourceChannel,
    target: { channel: targetChannel, version },
  };
}

function cacheWith(
  version: string | null,
  channel: UpdateChannel,
  manifest: UpdateCache['manifest'] = null,
): UpdateCache {
  return {
    source: 'cdn',
    channel,
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
  readonly installUpdate?: (
    source: InstallSource,
    plan: ActionableUpdatePlan,
    platform: NodeJS.Platform,
  ) => Promise<void>;
  readonly env?: Readonly<Record<string, string | undefined>>;
} = {}) {
  const installUpdate =
    overrides.installUpdate ??
    vi.fn<(
      source: InstallSource,
      plan: ActionableUpdatePlan,
      platform: NodeJS.Platform,
    ) => Promise<void>>().mockResolvedValue(undefined);

  return {
    env: overrides.env ?? {},
    refreshUpdateCache: vi.fn().mockImplementation((channel: UpdateChannel) =>
      Promise.resolve(cacheWith(overrides.latest ?? '0.5.0', channel, overrides.manifest ?? null)),
    ),
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
    const plan = upgradePlan('stable', '0.5.0');

    await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(deps.detectInstallSource).toHaveBeenCalledTimes(1);
    expect(deps.promptForInstallChoice).toHaveBeenCalledWith({
      currentVersion: '0.4.0',
      plan,
      installCommand: 'npm install -g @moonshot-ai/kimi-code@0.5.0',
      installSource: 'npm-global',
    });
    expect(deps.refreshUpdateCache).toHaveBeenCalledWith('stable');
    expect(deps.installUpdate).toHaveBeenCalledWith('npm-global', plan, 'darwin');
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

  it('prints up-to-date status without installing when no newer version exists', async () => {
    const { stdout, writable } = captureOutput();
    const deps = createDeps({ latest: '0.4.0' });

    await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.detectInstallSource).toHaveBeenCalledTimes(1);
    expect(deps.detectInstallSource).toHaveBeenCalledWith({ allowGlobalPrefix: false });
    expect(deps.installUpdate).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledWith('upgrade_command_no_update', expect.objectContaining({
      current_version: '0.4.0',
    }));
    expect(stdout.join('')).toContain('Kimi Code is already up to date (v0.4.0).');
  });

  it('defers the full source probe through the default dependency assembly', async () => {
    const sourceModule = await import('#/cli/update/source');
    const detector = vi.spyOn(sourceModule, 'detectInstallSource');
    const { writable } = captureOutput();
    try {
      detector.mockResolvedValue(null);
      const deps = { ...createDeps({ latest: '0.4.0' }), detectInstallSource: undefined };
      await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(0);
      expect(detector).toHaveBeenCalledWith({ allowGlobalPrefix: false });
      expect(detector).toHaveBeenCalledTimes(1);

      detector.mockClear();
      detector.mockResolvedValueOnce(null).mockResolvedValueOnce('npm-global');
      const actionable = { ...createDeps({ latest: '0.5.0' }), detectInstallSource: undefined };
      await expect(handleUpgrade('0.4.0', { ...actionable, ...writable })).resolves.toBe(0);
      expect(detector).toHaveBeenCalledTimes(2);
      expect(detector.mock.calls[0]).toEqual([{ allowGlobalPrefix: false }]);
      expect(detector.mock.calls[1]).toEqual([]);
    } finally {
      detector.mockRestore();
    }
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

  it('prints the manual update command without prompting when not interactive, and installs directly with yes', async () => {
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

    const yesRun = captureOutput();
    const yesDeps = createDeps({ latest: '0.5.0', source: 'npm-global', isInteractive: false });

    await expect(handleUpgrade('0.4.0', { ...yesDeps, ...yesRun.writable, yes: true })).resolves.toBe(0);

    expect(yesDeps.promptForInstallChoice).not.toHaveBeenCalled();
    expect(yesDeps.installUpdate).toHaveBeenCalledWith('npm-global', upgradePlan('stable', '0.5.0'), 'darwin');
    expect(yesDeps.track).not.toHaveBeenCalledWith('upgrade_command_prompted', expect.anything());
    expect(yesDeps.track).toHaveBeenCalledWith('upgrade_command_install_selected', expect.objectContaining({
      target_version: '0.5.0',
      source: 'npm-global',
    }));
    expect(yesRun.stdout.join('')).toContain('Updated @moonshot-ai/kimi-code to 0.5.0');
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

    expect(deps.detectInstallSource).toHaveBeenCalledTimes(1);
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
      manifest: {
        version: '0.5.0',
        publishedAt: new Date(Date.now() - 1_000).toISOString(),
        rollout: [{ percent: 100, delaySeconds: 86_400 }],
      },
    });

    await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(0);

    expect(deps.installUpdate).toHaveBeenCalledWith('npm-global', upgradePlan('stable', '0.5.0'), 'darwin');
    expect(stdout.join('')).toContain('Updated @moonshot-ai/kimi-code to 0.5.0');
  });

  describe('update channels', () => {
    it('follows a dev installation by default and installs a newer dev build', async () => {
      const { stdout, writable } = captureOutput();
      const deps = createDeps({ latest: NEXT_DEV });

      await expect(handleUpgrade(DEV, { ...deps, ...writable })).resolves.toBe(0);

      expect(deps.refreshUpdateCache).toHaveBeenCalledWith('dev');
      expect(deps.installUpdate).toHaveBeenCalledWith('npm-global', upgradePlan('dev', NEXT_DEV), 'darwin');
      expect(stdout.join('')).toContain(`Updated @moonshot-ai/kimi-code to ${NEXT_DEV}`);
    });

    it('shows a dev update command for a native dev installation in a non-interactive run', async () => {
      const { stdout, writable } = captureOutput();
      const deps = createDeps({
        latest: NEXT_DEV,
        source: 'native',
        isInteractive: false,
      });

      await expect(handleUpgrade(DEV, { ...deps, ...writable })).resolves.toBe(0);

      expect(deps.installUpdate).not.toHaveBeenCalled();
      expect(stdout.join('')).toContain('KIMI_CODE_UPDATE_CHANNEL=dev kimi update --yes');
      expect(stdout.join('')).not.toContain('/install.sh');
    });

    it('switches from stable to dev after confirmation even when dev has a lower version', async () => {
      const { stdout, writable } = captureOutput();
      const deps = createDeps({
        latest: FIXED_DEV,
        source: 'native',
        env: { KIMI_CODE_UPDATE_CHANNEL: 'dev' },
      });
      const plan = switchPlan('stable', 'dev', FIXED_DEV);

      await expect(handleUpgrade('2.5.0', { ...deps, ...writable })).resolves.toBe(0);

      expect(deps.promptForInstallChoice).toHaveBeenCalledWith(expect.objectContaining({
        currentVersion: '2.5.0',
        plan,
        installCommand: 'KIMI_CODE_UPDATE_CHANNEL=dev kimi update --yes',
      }));
      expect(deps.installUpdate).toHaveBeenCalledWith('native', plan, 'darwin');
      expect(stdout.join('')).toContain(`Switched @moonshot-ai/kimi-code to dev ${FIXED_DEV}`);
    });

    it('switches a dev build back to stable after confirmation', async () => {
      const { stdout, writable } = captureOutput();
      const deps = createDeps({
        latest: '2.4.1',
        source: 'native',
        env: { KIMI_CODE_UPDATE_CHANNEL: 'stable' },
      });
      const plan = switchPlan('dev', 'stable', '2.4.1');

      await expect(handleUpgrade(DEV, { ...deps, ...writable })).resolves.toBe(0);

      expect(deps.promptForInstallChoice).toHaveBeenCalledWith(expect.objectContaining({
        currentVersion: DEV,
        plan,
      }));
      expect(deps.installUpdate).toHaveBeenCalledWith('native', plan, 'darwin');
      expect(deps.track).toHaveBeenCalledWith('upgrade_command_succeeded', expect.objectContaining({
        target_version: '2.4.1',
        intent: 'switch-channel',
      }));
      expect(stdout.join('')).toContain('Switched @moonshot-ai/kimi-code to stable 2.4.1');
    });

    it('does not switch outside a terminal without yes, then treats yes as confirmation', async () => {
      const { stdout, writable } = captureOutput();
      const deps = createDeps({
        latest: FIXED_DEV,
        source: 'native',
        isInteractive: false,
        env: { KIMI_CODE_UPDATE_CHANNEL: 'dev' },
      });

      await expect(handleUpgrade('2.5.0', { ...deps, ...writable })).resolves.toBe(0);

      expect(deps.installUpdate).not.toHaveBeenCalled();
      expect(deps.promptForInstallChoice).not.toHaveBeenCalled();
      expect(stdout.join('')).toContain('Release channel: stable -> dev');
      expect(stdout.join('')).toContain(FIXED_DEV);
      expect(stdout.join('')).toContain('KIMI_CODE_UPDATE_CHANNEL=dev kimi update --yes');
      expect(stdout.join('')).not.toContain('/install.sh');

      const yesRun = captureOutput();
      const yesDeps = createDeps({
        latest: FIXED_DEV,
        source: 'native',
        isInteractive: false,
        env: { KIMI_CODE_UPDATE_CHANNEL: 'dev' },
      });
      await expect(handleUpgrade('2.5.0', { ...yesDeps, ...yesRun.writable, yes: true })).resolves.toBe(0);
      expect(yesDeps.promptForInstallChoice).not.toHaveBeenCalled();
      expect(yesDeps.installUpdate).toHaveBeenCalledWith('native', switchPlan('stable', 'dev', FIXED_DEV), 'darwin');
    });

    it('warns about an invalid channel value and follows the installed dev channel', async () => {
      const { stderr, writable } = captureOutput();
      const deps = createDeps({
        latest: NEXT_DEV,
        env: { KIMI_CODE_UPDATE_CHANNEL: 'nightly' },
      });

      await expect(handleUpgrade(DEV, { ...deps, ...writable })).resolves.toBe(0);

      expect(stderr.join('')).toContain('warning: ignoring KIMI_CODE_UPDATE_CHANNEL="nightly"');
      expect(stderr.join('')).toContain('Using dev');
      expect(deps.refreshUpdateCache).toHaveBeenCalledWith('dev');
      expect(deps.installUpdate).toHaveBeenCalledWith('npm-global', upgradePlan('dev', NEXT_DEV), 'darwin');
    });

    it('keeps Homebrew on stable even when dev is explicitly selected', async () => {
      const { stdout, writable } = captureOutput();
      const deps = createDeps({
        latest: '0.5.0',
        source: 'homebrew',
        env: { KIMI_CODE_UPDATE_CHANNEL: 'dev' },
      });

      await expect(handleUpgrade('0.4.0', { ...deps, ...writable })).resolves.toBe(0);

      expect(deps.refreshUpdateCache).toHaveBeenCalledWith('stable');
      expect(deps.installUpdate).not.toHaveBeenCalled();
      expect(stdout.join('')).toContain('brew upgrade kimi-code');
      expect(stdout.join('')).not.toContain('dev');
    });

    it('returns a check failure for a dev outage without falling back to stable', async () => {
      const { stderr, writable } = captureOutput();
      const deps = {
        ...createDeps({ env: { KIMI_CODE_UPDATE_CHANNEL: 'dev' } }),
        refreshUpdateCache: vi.fn().mockRejectedValue(new Error('dev unavailable')),
      };

      await expect(handleUpgrade('2.4.0', { ...deps, ...writable })).resolves.toBe(1);

      expect(deps.refreshUpdateCache).toHaveBeenCalledWith('dev');
      expect(deps.installUpdate).not.toHaveBeenCalled();
      expect(stderr.join('')).toContain('error: failed to check for updates: dev unavailable');
    });
  });
});
