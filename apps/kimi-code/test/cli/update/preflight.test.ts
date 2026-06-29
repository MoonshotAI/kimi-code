import type * as ChildProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readUpdateCache } from '#/cli/update/cache';
import {
  emptyUpdateInstallState,
  readUpdateInstallState,
  writeUpdateInstallState,
} from '#/cli/update/install-state';
import { runUpdatePreflight, spawnForSource } from '#/cli/update/preflight';
import { promptForInstallChoice } from '#/cli/update/prompt';
import type * as PromptModule from '#/cli/update/prompt';
import { refreshUpdateCache } from '#/cli/update/refresh';
import type * as RefreshModule from '#/cli/update/refresh';
import type * as RolloutModule from '#/cli/update/rollout';
import { detectInstallSource } from '#/cli/update/source';
import {
  emptyUpdateCache,
  type UpdateCache,
  type UpdateInstallState,
  type UpdateManifest,
} from '#/cli/update/types';
import type { TuiConfig } from '#/tui/config';

const mocks = vi.hoisted(() => ({
  readUpdateCache: vi.fn(),
  readUpdateInstallState: vi.fn(),
  writeUpdateInstallState: vi.fn(),
  tryAcquireUpdateInstallLock: vi.fn(),
  loadTuiConfig: vi.fn(),
  detectInstallSource: vi.fn(),
  promptForInstallChoice: vi.fn(),
  refreshUpdateCache: vi.fn(),
  resolveUpdateDeviceId: vi.fn(),
  appendRolloutDecisionLog: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../../src/cli/update/cache', () => ({
  readUpdateCache: mocks.readUpdateCache,
}));

vi.mock('../../../src/cli/update/install-lock', () => ({
  tryAcquireUpdateInstallLock: mocks.tryAcquireUpdateInstallLock,
}));

vi.mock('../../../src/cli/update/install-state', () => ({
  emptyUpdateInstallState: () => ({
    active: null,
    lastFailure: null,
    lastSuccess: null,
  }),
  readUpdateInstallState: mocks.readUpdateInstallState,
  writeUpdateInstallState: mocks.writeUpdateInstallState,
}));

vi.mock('../../../src/tui/config', () => ({
  loadTuiConfig: mocks.loadTuiConfig,
  TuiConfigParseError: class TuiConfigParseError extends Error {
    readonly fallback: TuiConfig;

    constructor(fallback: TuiConfig) {
      super('Invalid client preferences in ~/.kimi-code/tui.toml; using defaults.');
      this.fallback = fallback;
    }
  },
}));

vi.mock('../../../src/cli/update/source', () => ({
  detectInstallSource: mocks.detectInstallSource,
}));

vi.mock('../../../src/cli/update/prompt', async () => {
  const actual = await vi.importActual<typeof PromptModule>('../../../src/cli/update/prompt.js');
  return {
    ...actual,
    promptForInstallChoice: mocks.promptForInstallChoice,
  };
});

vi.mock('../../../src/cli/update/refresh', async () => {
  const actual = await vi.importActual<typeof RefreshModule>('../../../src/cli/update/refresh.js');
  return {
    ...actual,
    refreshUpdateCache: mocks.refreshUpdateCache,
  };
});

vi.mock('../../../src/cli/update/rollout', async () => {
  const actual = await vi.importActual<typeof RolloutModule>('../../../src/cli/update/rollout.js');
  return {
    ...actual,
    resolveUpdateDeviceId: mocks.resolveUpdateDeviceId,
    // Stubbed so preflight tests never write a real rollout.log.
    appendRolloutDecisionLog: mocks.appendRolloutDecisionLog,
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof ChildProcess>('node:child_process');
  return {
    ...actual,
    spawn: mocks.spawn,
  };
});

function cacheWith(version: string): UpdateCache {
  return {
    source: 'cdn',
    checkedAt: '2026-04-23T08:00:00.000Z',
    latest: version,
    manifest: null,
  };
}

function manifestFor(version: string, overrides: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    version,
    publishedAt: '2020-01-01T00:00:00.000Z',
    rollout: [],
    ...overrides,
  };
}

function cacheWithManifest(manifest: UpdateManifest): UpdateCache {
  return {
    source: 'cdn',
    checkedAt: '2026-04-23T08:00:00.000Z',
    latest: manifest.version,
    manifest,
  };
}

/** Every bucket delayed by 24h and the clock just started: nobody is eligible. */
function heldForEveryone(version: string): UpdateManifest {
  return manifestFor(version, {
    publishedAt: new Date(Date.now() - 1_000).toISOString(),
    rollout: [{ percent: 100, delaySeconds: 86_400 }],
  });
}

/** Every bucket immediate and publishedAt long past: everybody is eligible. */
function releasedForEveryone(version: string): UpdateManifest {
  return manifestFor(version, {
    rollout: [{ percent: 100, delaySeconds: 0 }],
  });
}

function installState(overrides: Partial<UpdateInstallState> = {}): UpdateInstallState {
  return {
    active: null,
    lastFailure: null,
    lastSuccess: null,
    ...overrides,
  };
}

function tuiConfig(overrides: Partial<TuiConfig> = {}): TuiConfig {
  return {
    theme: 'auto',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    ...overrides,
  };
}

function disableAutoInstall(): void {
  mocks.loadTuiConfig.mockResolvedValue(tuiConfig({ upgrade: { autoInstall: false } }));
}

function captureOutput(): {
  stdout: string[];
  stderr: string[];
  options: {
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
    isTTY: boolean;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    options: {
      stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
      stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
      isTTY: true,
    },
  };
}

type TestLogFn = ReturnType<typeof vi.fn<(message: string, payload?: unknown) => void>>;

function captureLogger(): {
  info: TestLogFn;
  warn: TestLogFn;
  error: TestLogFn;
  debug: TestLogFn;
} {
  return {
    info: vi.fn<(message: string, payload?: unknown) => void>(),
    warn: vi.fn<(message: string, payload?: unknown) => void>(),
    error: vi.fn<(message: string, payload?: unknown) => void>(),
    debug: vi.fn<(message: string, payload?: unknown) => void>(),
  };
}

function mockSpawnExit(code: number, signal: NodeJS.Signals | null = null): void {
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => { child.emit('exit', code, signal); });
    return child;
  });
}

async function flushBackgroundInstall(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('runUpdatePreflight', () => {
  beforeEach(() => {
    mocks.readUpdateInstallState.mockResolvedValue(emptyUpdateInstallState());
    mocks.writeUpdateInstallState.mockResolvedValue(undefined);
    mocks.loadTuiConfig.mockResolvedValue(tuiConfig());
    mocks.resolveUpdateDeviceId.mockReturnValue('test-device');
    mocks.appendRolloutDecisionLog.mockResolvedValue(undefined);
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({
      filePath: '/tmp/kimi-update-install.lock',
      release: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

  it('skips all update work when KIMI_CODE_NO_AUTO_UPDATE is set', async () => {
    vi.stubEnv('KIMI_CODE_NO_AUTO_UPDATE', '1');
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

    expect(readUpdateCache).not.toHaveBeenCalled();
    expect(refreshUpdateCache).not.toHaveBeenCalled();
    expect(detectInstallSource).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('also honors the legacy KIMI_CLI_NO_AUTO_UPDATE alias', async () => {
    vi.stubEnv('KIMI_CLI_NO_AUTO_UPDATE', 'true');
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

    expect(readUpdateCache).not.toHaveBeenCalled();
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('starts an automatic update from the first fresh check when the cache is empty', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(0);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(readUpdateCache).toHaveBeenCalledTimes(1);
    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(detectInstallSource).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^npm(\.cmd)?$/),
      ['install', '-g', '@moonshot-ai/kimi-code@0.5.0'],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('does not start a fresh-check background install when automatic updates are disabled', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(detectInstallSource).toHaveBeenCalledTimes(1);
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('skips when non-interactive', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    const { options } = captureOutput();
    await expect(
      runUpdatePreflight('0.4.0', { ...options, isTTY: false }),
    ).resolves.toBe('continue');
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('does not start a fresh-check background install when non-interactive', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    const { options } = captureOutput();

    await expect(
      runUpdatePreflight('0.4.0', { ...options, isTTY: false }),
    ).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(detectInstallSource).not.toHaveBeenCalled();
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('npm-global: prompts and spawns npm install -g when automatic updates are disabled', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('exit');
    expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        installCommand: 'npm install -g @moonshot-ai/kimi-code@0.5.0',
        installSource: 'npm-global',
      }),
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^npm(\.cmd)?$/),
      ['install', '-g', '@moonshot-ai/kimi-code@0.5.0'],
      { stdio: 'inherit' },
    );
    expect(stdout.join('')).toContain('Updated @moonshot-ai/kimi-code to 0.5.0');
  });

  it('refreshes a stale cached target before showing the foreground install prompt', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.6.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.7.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.5.0', options)).resolves.toBe('exit');

    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { version: '0.7.0' },
        installCommand: 'npm install -g @moonshot-ai/kimi-code@0.7.0',
      }),
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^npm(\.cmd)?$/),
      ['install', '-g', '@moonshot-ai/kimi-code@0.7.0'],
      { stdio: 'inherit' },
    );
    expect(stdout.join('')).toContain('Updated @moonshot-ai/kimi-code to 0.7.0');
  });

  it('falls back to the cached foreground prompt target when the refresh hangs', async () => {
    vi.useFakeTimers();
    try {
      disableAutoInstall();
      mocks.readUpdateCache.mockResolvedValue(cacheWith('0.6.0'));
      mocks.refreshUpdateCache.mockReturnValue(new Promise(() => {}));
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      mocks.promptForInstallChoice.mockResolvedValue('skip');
      const { options } = captureOutput();

      const result = runUpdatePreflight('0.5.0', options);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe('continue');
      expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { version: '0.6.0' },
          installCommand: 'npm install -g @moonshot-ai/kimi-code@0.6.0',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('pnpm-global: spawns pnpm add -g', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('pnpm-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const { options } = captureOutput();
    await runUpdatePreflight('0.4.0', options);
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^pnpm(\.cmd)?$/),
      ['add', '-g', '@moonshot-ai/kimi-code@0.5.0'],
      { stdio: 'inherit' },
    );
  });

  it('yarn-global: spawns yarn global add', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('yarn-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const { options } = captureOutput();
    await runUpdatePreflight('0.4.0', options);
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^yarn(\.cmd)?$/),
      ['global', 'add', '@moonshot-ai/kimi-code@0.5.0'],
      { stdio: 'inherit' },
    );
  });

  it('bun-global: spawns bun add -g', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('bun-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const { options } = captureOutput();
    await runUpdatePreflight('0.4.0', options);
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^bun(\.exe)?$/),
      ['add', '-g', '@moonshot-ai/kimi-code@0.5.0'],
      { stdio: 'inherit' },
    );
  });

  it('homebrew: prints manual brew upgrade command, does not spawn', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('homebrew');
    const { stdout, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stdout.join('')).toContain('brew upgrade kimi-code');
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('native on darwin: spawns bash -c with pipefail-guarded curl|bash', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const { options } = captureOutput();
      await runUpdatePreflight('0.4.0', options);
      const call = mocks.spawn.mock.calls[0];
      expect(call?.[0]).toBe('bash');
      expect(call?.[2]).toEqual({ stdio: 'inherit' });
      const [flag, script] = call?.[1] as string[];
      expect(flag).toBe('-c');
      // pipefail must come before the pipeline so a failed `curl` is not masked
      // by the trailing `bash` exiting 0 (see "surfaces a failed curl" below).
      expect(script).toContain('set -o pipefail');
      expect(script).toContain('curl -fsSL https://code.kimi.com/kimi-code/install.sh');
      expect(script).toContain('| bash');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('native on win32: prints manual powershell command, does not spawn', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('native');
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const { stdout, options } = captureOutput();
      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
      expect(stdout.join('')).toContain('irm https://code.kimi.com/kimi-code/install.ps1 | iex');
      expect(promptForInstallChoice).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('unsupported: prints fallback npm command', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('unsupported');
    const { stdout, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stdout.join('')).toContain('npm install -g @moonshot-ai/kimi-code@0.5.0');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('declined install continues without spawn', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('skip');
    const { options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('warns and continues when spawn exits non-zero, without claiming success', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(1);
    const { stdout, stderr, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stderr.join('')).toContain('warning: failed to install');
    // A failed install must never print the "Updated …" success line.
    expect(stdout.join('')).not.toContain('Updated @moonshot-ai/kimi-code');
  });

  it('starts an automatic update in the background by default', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(0);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^npm(\.cmd)?$/),
      ['install', '-g', '@moonshot-ai/kimi-code@0.5.0'],
      { detached: true, stdio: 'ignore' },
    );
    expect(writeUpdateInstallState).toHaveBeenCalledWith(expect.objectContaining({
      active: expect.objectContaining({
        version: '0.5.0',
        source: 'npm-global',
        startedAt: expect.any(String),
      }),
      lastFailure: null,
    }));

    await flushBackgroundInstall();

    expect(writeUpdateInstallState).toHaveBeenLastCalledWith(expect.objectContaining({
      active: null,
      lastFailure: null,
      lastSuccess: expect.objectContaining({
        version: '0.5.0',
        installedAt: expect.any(String),
        notifiedAt: null,
      }),
    }));
  });

  it('tracks and logs successful background update installs', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(0);
    const { options } = captureOutput();
    const track = vi.fn();
    const logger = captureLogger();

    await expect(runUpdatePreflight('0.4.0', { ...options, track, logger })).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(track).toHaveBeenCalledWith('update_background_install_started', expect.objectContaining({
      current_version: '0.4.0',
      target_version: '0.5.0',
      source: 'npm-global',
    }));
    expect(track).toHaveBeenCalledWith('update_background_install_succeeded', expect.objectContaining({
      target_version: '0.5.0',
      source: 'npm-global',
    }));
    expect(logger.info).toHaveBeenCalledWith('background update install started', expect.objectContaining({
      currentVersion: '0.4.0',
      targetVersion: '0.5.0',
      source: 'npm-global',
    }));
    expect(logger.info).toHaveBeenCalledWith('background update install succeeded', expect.objectContaining({
      targetVersion: '0.5.0',
      source: 'npm-global',
    }));
  });

  it('defaults to automatic background updates when client preferences cannot be loaded', async () => {
    mocks.loadTuiConfig.mockRejectedValue(new Error('broken tui.toml'));
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(0);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^npm(\.cmd)?$/),
      ['install', '-g', '@moonshot-ai/kimi-code@0.5.0'],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('starts only one background update when two sessions preflight concurrently', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    let acquired = false;
    mocks.tryAcquireUpdateInstallLock.mockImplementation(async () => {
      if (acquired) return null;
      acquired = true;
      return {
        filePath: '/tmp/kimi-update-install.lock',
        release: vi.fn().mockResolvedValue(undefined),
      };
    });
    mockSpawnExit(0);
    const first = captureOutput();
    const second = captureOutput();

    await expect(Promise.all([
      runUpdatePreflight('0.4.0', first.options),
      runUpdatePreflight('0.4.0', second.options),
    ])).resolves.toEqual(['continue', 'continue']);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('records the first background failure silently so the next launch can retry', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(1);
    const { stderr, options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(stderr.join('')).toBe('');
    expect(writeUpdateInstallState).toHaveBeenLastCalledWith(expect.objectContaining({
      active: null,
      lastFailure: expect.objectContaining({
        version: '0.5.0',
        attempts: 1,
        failedAt: expect.any(String),
      }),
      lastSuccess: null,
    }));
  });

  it('tracks and logs background update install failures without writing stderr', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(1);
    const { stderr, options } = captureOutput();
    const track = vi.fn();
    const logger = captureLogger();

    await expect(runUpdatePreflight('0.4.0', { ...options, track, logger })).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(stderr.join('')).toBe('');
    expect(track).toHaveBeenCalledWith('update_background_install_failed', expect.objectContaining({
      target_version: '0.5.0',
      source: 'npm-global',
      attempts: 1,
    }));
    expect(logger.warn).toHaveBeenCalledWith('background update install failed', expect.objectContaining({
      targetVersion: '0.5.0',
      source: 'npm-global',
      attempts: 1,
    }));
  });

  it('retries automatic update once after the first background failure', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      lastFailure: {
        version: '0.5.0',
        failedAt: '2026-04-23T08:00:00.000Z',
        attempts: 1,
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(1);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(writeUpdateInstallState).toHaveBeenLastCalledWith(expect.objectContaining({
      lastFailure: expect.objectContaining({
        version: '0.5.0',
        attempts: 2,
      }),
    }));
  });

  it('prompts for manual foreground install after two background failures', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      lastFailure: {
        version: '0.5.0',
        failedAt: '2026-04-23T08:00:00.000Z',
        attempts: 2,
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('skip');
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

    expect(promptForInstallChoice).toHaveBeenCalledWith(expect.objectContaining({
      target: { version: '0.5.0' },
      installSource: 'npm-global',
    }));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('shows a one-shot notice after a background update succeeds and the new version starts', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      lastSuccess: {
        version: '0.5.0',
        installedAt: '2026-04-23T08:00:00.000Z',
        notifiedAt: null,
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(emptyUpdateCache());
    const { stdout, options } = captureOutput();
    const track = vi.fn();
    const logger = captureLogger();

    await expect(runUpdatePreflight('0.5.0', { ...options, track, logger })).resolves.toBe('continue');

    const rendered = stdout.join('');
    expect(rendered).toContain('Kimi Code updated to v0.5.0');
    expect(rendered).toContain(
      'https://moonshotai.github.io/kimi-code/en/release-notes/changelog.html',
    );
    expect(track).toHaveBeenCalledWith('update_success_notice_shown', expect.objectContaining({
      version: '0.5.0',
      inferred_from_active: false,
    }));
    expect(logger.info).toHaveBeenCalledWith('background update success notice shown', expect.objectContaining({
      version: '0.5.0',
      inferredFromActive: false,
    }));
    expect(writeUpdateInstallState).toHaveBeenCalledWith(expect.objectContaining({
      lastSuccess: expect.objectContaining({
        version: '0.5.0',
        notifiedAt: expect.any(String),
      }),
    }));
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('infers a background update success notice when the active install version is now running', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      active: {
        version: '0.5.0',
        source: 'npm-global',
        startedAt: '2026-04-23T08:00:00.000Z',
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(emptyUpdateCache());
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.5.0', options)).resolves.toBe('continue');

    expect(stdout.join('')).toContain('Kimi Code updated to v0.5.0');
    expect(writeUpdateInstallState).toHaveBeenCalledWith(expect.objectContaining({
      active: null,
      lastFailure: null,
      lastSuccess: expect.objectContaining({
        version: '0.5.0',
        notifiedAt: expect.any(String),
      }),
    }));
  });

  it('tracks update_prompted telemetry', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('skip');
    const { options } = captureOutput();
    const track = vi.fn();
    await runUpdatePreflight('0.4.0', { ...options, track });
    expect(track).toHaveBeenCalledWith('update_prompted', expect.objectContaining({
      current_version: '0.4.0',
      target_version: '0.5.0',
      decision: 'prompt-install',
      source: 'npm-global',
    }));
  });

  describe('rollout gating', () => {
    it('hides a cached update whose batch is not yet eligible', async () => {
      const held = cacheWithManifest(heldForEveryone('0.5.0'));
      mocks.readUpdateCache.mockResolvedValue(held);
      mocks.refreshUpdateCache.mockResolvedValue(held);
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      const { stdout, options } = captureOutput();

      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
      await flushBackgroundInstall();

      expect(stdout.join('')).toBe('');
      expect(promptForInstallChoice).not.toHaveBeenCalled();
      expect(detectInstallSource).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
      // The launch still refreshes the cache in the background so the device
      // flips to eligible purely by time passing.
      expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
      // Both checks of this launch are recorded in the rollout log.
      expect(mocks.appendRolloutDecisionLog).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'startup-cache',
        reason: 'held',
        current: '0.4.0',
        latest: '0.5.0',
        bucket: expect.any(Number),
        delaySeconds: 86_400,
        eligibleAt: expect.any(String),
      }));
      expect(mocks.appendRolloutDecisionLog).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'background-refresh',
        reason: 'held',
      }));
    });

    it('starts the background install once the device batch is eligible', async () => {
      const released = cacheWithManifest(releasedForEveryone('0.5.0'));
      mocks.readUpdateCache.mockResolvedValue(released);
      mocks.refreshUpdateCache.mockResolvedValue(released);
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      mockSpawnExit(0);
      const { options } = captureOutput();
      const track = vi.fn();

      await expect(runUpdatePreflight('0.4.0', { ...options, track })).resolves.toBe('continue');
      await flushBackgroundInstall();

      expect(mocks.spawn).toHaveBeenCalledWith(
        expect.stringMatching(/^npm(\.cmd)?$/),
        ['install', '-g', '@moonshot-ai/kimi-code@0.5.0'],
        { detached: true, stdio: 'ignore' },
      );
      expect(track).toHaveBeenCalledWith('update_background_install_started', expect.objectContaining({
        target_version: '0.5.0',
        rollout_bucket: expect.any(Number),
        rollout_delay_seconds: 0,
        rollout_from_manifest: true,
      }));
      expect(mocks.appendRolloutDecisionLog).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'startup-cache',
        reason: 'eligible',
        target: '0.5.0',
      }));
    });

    it('prompts with rollout telemetry when eligible and auto-install is disabled', async () => {
      disableAutoInstall();
      const released = cacheWithManifest(releasedForEveryone('0.5.0'));
      mocks.readUpdateCache.mockResolvedValue(released);
      mocks.refreshUpdateCache.mockResolvedValue(released);
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      mocks.promptForInstallChoice.mockResolvedValue('skip');
      const { options } = captureOutput();
      const track = vi.fn();

      await expect(runUpdatePreflight('0.4.0', { ...options, track })).resolves.toBe('continue');

      expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
        expect.objectContaining({ target: { version: '0.5.0' } }),
      );
      expect(track).toHaveBeenCalledWith('update_prompted', expect.objectContaining({
        target_version: '0.5.0',
        rollout_bucket: expect.any(Number),
        rollout_delay_seconds: 0,
        rollout_from_manifest: true,
      }));
    });

    it('uses the refreshed manifest for rollout telemetry when the prompt target changes', async () => {
      disableAutoInstall();
      const cached = cacheWithManifest(manifestFor('0.6.0', {
        publishedAt: '2020-01-01T00:00:00.000Z',
        rollout: [{ percent: 100, delaySeconds: 0 }],
      }));
      const refreshed = cacheWithManifest(manifestFor('0.7.0', {
        publishedAt: '2020-01-01T00:00:00.000Z',
        rollout: [{ percent: 100, delaySeconds: 43_200 }],
      }));
      mocks.readUpdateCache.mockResolvedValue(cached);
      mocks.refreshUpdateCache.mockResolvedValue(refreshed);
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      mocks.promptForInstallChoice.mockResolvedValue('skip');
      const { options } = captureOutput();
      const track = vi.fn();

      await expect(runUpdatePreflight('0.5.0', { ...options, track })).resolves.toBe('continue');

      expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
        expect.objectContaining({ target: { version: '0.7.0' } }),
      );
      expect(track).toHaveBeenCalledWith('update_prompted', expect.objectContaining({
        target_version: '0.7.0',
        rollout_bucket: expect.any(Number),
        rollout_delay_seconds: 43_200,
        rollout_from_manifest: true,
      }));
    });

    it('suppresses the manual-command notice while a homebrew device batch is held', async () => {
      const held = cacheWithManifest(heldForEveryone('0.5.0'));
      mocks.readUpdateCache.mockResolvedValue(held);
      mocks.refreshUpdateCache.mockResolvedValue(held);
      mocks.detectInstallSource.mockResolvedValue('homebrew');
      const { stdout, options } = captureOutput();

      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
      await flushBackgroundInstall();

      expect(stdout.join('')).toBe('');
      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('does not start a fresh-check background install while the refreshed manifest is held', async () => {
      mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
      mocks.refreshUpdateCache.mockResolvedValue(cacheWithManifest(heldForEveryone('0.5.0')));
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      const { options } = captureOutput();

      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
      await flushBackgroundInstall();

      expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
      expect(detectInstallSource).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('stays silent when the user-visible refresh reveals a held newer version', async () => {
      disableAutoInstall();
      mocks.readUpdateCache.mockResolvedValue(cacheWithManifest(releasedForEveryone('0.6.0')));
      mocks.refreshUpdateCache.mockResolvedValue(cacheWithManifest(heldForEveryone('0.7.0')));
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      const { stdout, options } = captureOutput();

      await expect(runUpdatePreflight('0.5.0', options)).resolves.toBe('continue');

      expect(stdout.join('')).toBe('');
      expect(promptForInstallChoice).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('KIMI_CODE_EXPERIMENTAL_FLAG bypasses the rollout: held devices still update', async () => {
      vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');
      const held = cacheWithManifest(heldForEveryone('0.5.0'));
      mocks.readUpdateCache.mockResolvedValue(held);
      mocks.refreshUpdateCache.mockResolvedValue(held);
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      mockSpawnExit(0);
      const { options } = captureOutput();
      const track = vi.fn();

      await expect(runUpdatePreflight('0.4.0', { ...options, track })).resolves.toBe('continue');
      await flushBackgroundInstall();

      expect(mocks.spawn).toHaveBeenCalledWith(
        expect.stringMatching(/^npm(\.cmd)?$/),
        ['install', '-g', '@moonshot-ai/kimi-code@0.5.0'],
        { detached: true, stdio: 'ignore' },
      );
      expect(track).toHaveBeenCalledWith('update_background_install_started', expect.objectContaining({
        target_version: '0.5.0',
        rollout_bypassed: true,
      }));
      expect(mocks.appendRolloutDecisionLog).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'startup-cache',
        reason: 'experimental',
        target: '0.5.0',
      }));
    });

    it('KIMI_CODE_NO_AUTO_UPDATE still wins over the experimental flag', async () => {
      vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');
      vi.stubEnv('KIMI_CODE_NO_AUTO_UPDATE', '1');
      mocks.readUpdateCache.mockResolvedValue(cacheWithManifest(releasedForEveryone('0.5.0')));
      const { options } = captureOutput();

      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

      expect(readUpdateCache).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('treats any plan older than 24h as fully rolled out', async () => {
      disableAutoInstall();
      const staleRollout = manifestFor('0.5.0', {
        publishedAt: new Date(Date.now() - 25 * 3_600 * 1_000).toISOString(),
        rollout: [
          { percent: 30, delaySeconds: 0 },
          { percent: 30, delaySeconds: 43_200 },
          { percent: 40, delaySeconds: 86_400 },
        ],
      });
      mocks.readUpdateCache.mockResolvedValue(cacheWithManifest(staleRollout));
      mocks.refreshUpdateCache.mockResolvedValue(cacheWithManifest(staleRollout));
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      mocks.promptForInstallChoice.mockResolvedValue('skip');
      const { options } = captureOutput();

      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

      expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
        expect.objectContaining({ target: { version: '0.5.0' } }),
      );
    });
  });
});

describe('spawnForSource native', () => {
  // No spawn mock here — we run real bash to prove the failure contract
  // end-to-end. `curl … | bash` reports only the trailing bash's exit status,
  // so a curl that never connects (exit 7, empty stdin → bash exits 0) is
  // masked and the update is wrongly reported as successful. `set -o pipefail`
  // makes the pipeline surface curl's failure. Shadowing `curl` with a shell
  // function keeps this offline and deterministic; skipped on Windows (no bash,
  // and native auto-install is unsupported there anyway).
  it.skipIf(process.platform === 'win32')(
    'surfaces a failed curl download as a non-zero exit',
    () => {
      const { cmd, args } = spawnForSource('native', '0.5.0', 'darwin');
      const script = `curl() { return 7; }\n${args[1] ?? ''}`;
      const result = spawnSync(cmd, [args[0] ?? '-c', script], { encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBeGreaterThan(0);
    },
  );
});
