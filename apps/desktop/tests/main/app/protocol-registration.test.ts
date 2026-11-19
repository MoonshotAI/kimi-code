import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const compiler = process.env['KIMI_NSIS_PATH'];
const enabled = process.platform === 'win32' && compiler !== undefined && existsSync(compiler);
const registryPath = `Software\\Classes\\kimi-code-protocol-test-${randomUUID()}`;
const registryKey = `HKCU\\${registryPath}`;
const desktopRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe.skipIf(!enabled)('Windows installer protocol lifecycle', () => {
  let directory = '';
  let install = '';
  let uninstall = '';

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'kimi-protocol-'));
    install = join(directory, 'install.exe');
    uninstall = join(directory, 'uninstall.exe');
    for (const [output, extra] of [[install, []], [uninstall, ['/DTEST_UNINSTALL']]] as const) {
      execFileSync(compiler!, [
        '/V2', `/DTEST_OUTPUT=${output}`,
        `/DKIMI_PROTOCOL_REGISTRY_KEY=${registryPath}`,
        `/DPROTOCOL_INCLUDE=${join(desktopRoot, 'build/protocol-registration.nsh')}`,
        ...extra, join(desktopRoot, 'tests/main/fixtures/protocol-registration.nsi'),
      ], { windowsHide: true });
    }
  }, 30_000);

  afterAll(() => {
    spawnSync('reg.exe', ['delete', registryKey, '/f'], { windowsHide: true });
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function run(executable: string, path: string): void {
    const result = spawnSync(executable, ['/S', `/D=${path}`], { windowsHide: true, windowsVerbatimArguments: true });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
  }

  function command(): string {
    return execFileSync('reg.exe', ['query', `${registryKey}\\shell\\open\\command`, '/ve'], {
      encoding: 'utf8', windowsHide: true,
    });
  }

  it('registers before first launch, updates the target and only removes its own association', () => {
    const first = join(directory, 'first install');
    const second = join(directory, 'second install');
    run(install, first);
    expect(command()).toContain(`"${first}\\Kimi Code.exe" "%1"`);
    expect(execFileSync('reg.exe', ['query', registryKey, '/v', 'URL Protocol'], {
      encoding: 'utf8', windowsHide: true,
    })).toContain('REG_SZ');
    run(install, second);
    expect(command()).toContain(`"${second}\\Kimi Code.exe" "%1"`);
    run(uninstall, first);
    expect(command()).toContain(`"${second}\\Kimi Code.exe" "%1"`);
    run(uninstall, second);
    expect(spawnSync('reg.exe', ['query', registryKey], { windowsHide: true }).status).not.toBe(0);
  }, 30_000);
});

describe('installer channel isolation', () => {
  it.each([
    ['stable', 'false', 'false'],
    ['canary', 'true', 'false'],
    ['preview', 'false', 'true'],
  ])('only includes stable protocol hooks for %s', (channel, canary, preview) => {
    const output = execFileSync(process.execPath, ['-e',
      'const c=require(process.argv[1]); console.log(JSON.stringify({include:c.nsis.include,protocols:c.protocols}));',
      join(desktopRoot, 'electron-builder.config.cjs'),
    ], {
      env: { ...process.env, KIMI_DESKTOP_CANARY: canary, KIMI_DESKTOP_PREVIEW: preview },
      encoding: 'utf8', windowsHide: true,
    });
    const config = JSON.parse(output) as { include?: string; protocols: Array<{ schemes: string[] }> };
    if (channel === 'stable') {
      expect(config.include).toBe('build/installer-stable.nsh');
      expect(config.protocols[0]?.schemes).toEqual(['kimi-code']);
    } else {
      expect(config.include).toBe('build/installer.nsh');
      expect(config.protocols).toEqual([]);
    }
  });
});
