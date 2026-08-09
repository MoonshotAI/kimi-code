/**
 * Scenario: maintainers run the installed-VSIX smoke from a developer machine or CI.
 * Responsibilities: stable downloads cannot reuse stale caches, and the Extension
 * Host cannot discover the developer's real legacy Kimi home.
 * Wiring: real smoke orchestration and filesystem; @vscode/test-electron is the
 * external process/download boundary.
 * Run: pnpm --filter kimi-code exec vitest run --config vitest.config.ts test/extension-host-smoke.test.ts
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeTest = vi.hoisted(() => ({
  runTests: vi.fn(),
  runVSCodeCommand: vi.fn(),
}));

vi.mock('@vscode/test-electron', () => vscodeTest);

const { runExtensionHostSmoke } = await import('../scripts/extension-host-smoke.mjs');
const tempDirs: string[] = [];

beforeEach(() => {
  vscodeTest.runVSCodeCommand.mockResolvedValue({
    stdout: 'Extension was successfully installed.\n',
    stderr: '',
  });
  vscodeTest.runTests.mockImplementation(async (options) => {
    await writeFile(
      options.extensionTestsEnv.KIMI_VSCODE_SMOKE_REPORT,
      JSON.stringify({ vscode: options.version === 'stable' ? '1.127.0' : options.version }),
      'utf8',
    );
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('installed VSIX Extension Host smoke', () => {
  it('uses a fresh disposable download cache for every stable run', async () => {
    const fixture = await makeFixture();

    const first = await runExtensionHostSmoke({
      version: 'stable',
      vsixPath: fixture.vsixPath,
      cachePath: fixture.cachePath,
    });
    const second = await runExtensionHostSmoke({
      version: 'stable',
      vsixPath: fixture.vsixPath,
      cachePath: fixture.cachePath,
    });

    expect(first.cachePath).not.toBe(second.cachePath);
    expect(first.vscodeVersion).toBe('1.127.0');
    expect(second.vscodeVersion).toBe('1.127.0');
  });

  it('gives the harness separate Kimi and operating-system homes before activation', async () => {
    const fixture = await makeFixture();

    await runExtensionHostSmoke({
      version: '1.100.0',
      vsixPath: fixture.vsixPath,
      cachePath: fixture.cachePath,
    });

    const options = vscodeTest.runTests.mock.calls[0]?.[0];
    const env = options.extensionTestsEnv;
    expect(env.KIMI_CODE_HOME).not.toBe(env.KIMI_VSCODE_SMOKE_OS_HOME);
    expect(env.KIMI_VSCODE_SMOKE_OS_HOME).toContain('os-home');
  });

  it('rejects a cached host that does not match an exact requested version', async () => {
    const fixture = await makeFixture();
    vscodeTest.runTests.mockImplementationOnce(async (options) => {
      await writeFile(
        options.extensionTestsEnv.KIMI_VSCODE_SMOKE_REPORT,
        JSON.stringify({ vscode: '1.99.3' }),
        'utf8',
      );
    });

    await expect(runExtensionHostSmoke({
      version: '1.100.0',
      vsixPath: fixture.vsixPath,
      cachePath: fixture.cachePath,
    })).rejects.toThrow('Extension Host ran VS Code 1.99.3, expected requested version 1.100.0');
  });
});

async function makeFixture(): Promise<{ vsixPath: string; cachePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-extension-host-smoke-'));
  tempDirs.push(root);
  const cachePath = join(root, 'cache');
  const vsixPath = join(root, 'kimi-code-test.vsix');
  await mkdir(cachePath, { recursive: true });
  await writeFile(vsixPath, 'fixture', 'utf8');
  return { vsixPath, cachePath };
}
