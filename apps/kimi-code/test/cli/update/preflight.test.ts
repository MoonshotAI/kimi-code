import type * as ChildProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readUpdateCache } from '#/cli/update/cache';
import { runUpdatePreflight, spawnForSource } from '#/cli/update/preflight';
import { promptForInstallConfirmation } from '#/cli/update/prompt';
import type * as PromptModule from '#/cli/update/prompt';
import { refreshUpdateCache } from '#/cli/update/refresh';
import type * as RefreshModule from '#/cli/update/refresh';
import { detectInstallSource } from '#/cli/update/source';
import { emptyUpdateCache, type UpdateCache } from '#/cli/update/types';

const mocks = vi.hoisted(() => ({
  readUpdateCache: vi.fn(),
  detectInstallSource: vi.fn(),
  promptForInstallConfirmation: vi.fn(),
  refreshUpdateCache: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../../src/cli/update/cache', () => ({
  readUpdateCache: mocks.readUpdateCache,
}));

vi.mock('../../../src/cli/update/source', () => ({
  detectInstallSource: mocks.detectInstallSource,
}));

vi.mock('../../../src/cli/update/prompt', async () => {
  const actual = await vi.importActual<typeof PromptModule>('../../../src/cli/update/prompt.js');
  return {
    ...actual,
    promptForInstallConfirmation: mocks.promptForInstallConfirmation,
  };
});

vi.mock('../../../src/cli/update/refresh', async () => {
  const actual = await vi.importActual<typeof RefreshModule>('../../../src/cli/update/refresh.js');
  return {
    ...actual,
    refreshUpdateCache: mocks.refreshUpdateCache,
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
  };
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

function mockSpawnExit(code: number, signal: NodeJS.Signals | null = null): void {
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => { child.emit('exit', code, signal); });
    return child;
  });
}

describe('runUpdatePreflight', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('continues on first launch with empty cache, still refreshes in background', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.refreshUpdateCache.mockResolvedValue(emptyUpdateCache());
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(readUpdateCache).toHaveBeenCalledTimes(1);
    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(detectInstallSource).not.toHaveBeenCalled();
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

  it('npm-global: prompts and spawns npm install -g', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
    mockSpawnExit(0);
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('exit');
    expect(mocks.promptForInstallConfirmation).toHaveBeenCalledWith(
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

  it('pnpm-global: spawns pnpm add -g', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('pnpm-global');
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
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
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('yarn-global');
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
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
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('bun-global');
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
    mockSpawnExit(0);
    const { options } = captureOutput();
    await runUpdatePreflight('0.4.0', options);
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^bun(\.exe)?$/),
      ['add', '-g', '@moonshot-ai/kimi-code@0.5.0'],
      { stdio: 'inherit' },
    );
  });

  it('native on darwin: spawns bash -c with pipefail-guarded curl|bash', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
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
      expect(promptForInstallConfirmation).not.toHaveBeenCalled();
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
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallConfirmation.mockResolvedValue(false);
    const { options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('warns and continues when spawn exits non-zero, without claiming success', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
    mockSpawnExit(1);
    const { stdout, stderr, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stderr.join('')).toContain('warning: failed to install');
    // A failed install must never print the "Updated …" success line.
    expect(stdout.join('')).not.toContain('Updated @moonshot-ai/kimi-code');
  });

  it('tracks update_prompted telemetry', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallConfirmation.mockResolvedValue(false);
    const { options } = captureOutput();
    const track = vi.fn();
    await runUpdatePreflight('0.4.0', { ...options, track });
    expect(track).toHaveBeenCalledWith('update_prompted', expect.objectContaining({
      current: '0.4.0',
      latest: '0.5.0',
      decision: 'prompt-install',
      source: 'npm-global',
    }));
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
