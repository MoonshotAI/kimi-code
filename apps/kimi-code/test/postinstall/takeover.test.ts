import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeTakeover,
  planTakeover,
  verifyTakeover,
} from '../../scripts/postinstall/takeover.mjs';
import {
  detectPackageManager,
  isGlobalInstall,
  ownPackageRoot,
} from '../../scripts/postinstall/reach.mjs';
import { renameTargetFor, isSystemOwnedDir } from '../../scripts/postinstall/migrate.mjs';
import { executableCandidates } from '../../scripts/postinstall/platform.mjs';

const POSIX = process.platform !== 'win32';
const DELIM = POSIX ? ':' : ';';
const PLATFORM = process.platform;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'postinstall-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  for (const key of [
    'npm_config_global',
    'pnpm_config_global',
    'npm_config_location',
    'npm_config_user_agent',
    'npm_config_argv',
  ]) {
    delete process.env[key];
  }
});

interface TestEnv {
  ownRoot: string;
  ownBin: string;
  path: (...dirs: string[]) => string;
}

async function makeEnv(): Promise<TestEnv> {
  const ownRoot = join(root, 'ownpkg');
  const ownBin = join(root, 'ownbin');
  await mkdir(ownRoot, { recursive: true });
  await mkdir(ownBin, { recursive: true });
  await writeFile(join(ownRoot, 'package.json'), '{"name":"@moonshot-ai/kimi-code"}', 'utf-8');
  await writeFile(join(ownRoot, 'main.mjs'), '// kimi-code\n', 'utf-8');
  await chmod(join(ownRoot, 'main.mjs'), 0o755);
  await symlink(join(ownRoot, 'main.mjs'), join(ownBin, 'kimi'));
  return {
    ownRoot: await realpath(ownRoot),
    ownBin,
    path: (...dirs) => dirs.join(DELIM),
  };
}

async function makeLegacyShim(dirName: string): Promise<{ dir: string; shim: string }> {
  const dir = join(root, dirName);
  await mkdir(dir, { recursive: true });
  const shim = join(dir, 'kimi');
  await writeFile(shim, '#!/bin/sh\n# setuptools entry point for kimi_cli\n', 'utf-8');
  await chmod(shim, 0o755);
  return { dir, shim };
}

describe.runIf(POSIX)('shim takeover (POSIX fixtures)', () => {
  it('renames a single legacy shim to kimi-legacy and verifies the takeover', async () => {
    const env = await makeEnv();
    const legacy = await makeLegacyShim('uvbin');
    const detection = env.path(env.ownBin, legacy.dir);
    const reachability = env.path(env.ownBin, legacy.dir);

    const plan = await planTakeover(env.ownRoot, detection, reachability, PLATFORM);
    expect(plan.kind).toBe('proceed');
    if (plan.kind !== 'proceed') return;

    const outcomes = await executeTakeover(plan.classifications);
    expect(outcomes.renames).toHaveLength(1);
    expect(outcomes.errors).toHaveLength(0);
    expect(existsSync(join(legacy.dir, 'kimi-legacy'))).toBe(true);
    expect(existsSync(legacy.shim)).toBe(false);
    await expect(readFile(join(legacy.dir, 'kimi-legacy'), 'utf-8')).resolves.toContain(
      'kimi_cli',
    );

    const verify = await verifyTakeover(
      env.ownRoot,
      reachability,
      plan.classifications.map((c) => c.shimPath),
      PLATFORM,
    );
    expect(verify.kind).toBe('own');
  });

  it('preserves the first of two legacy shims and deletes the second', async () => {
    const env = await makeEnv();
    const first = await makeLegacyShim('uvbin');
    const second = await makeLegacyShim('pipxbin');
    const detection = env.path(env.ownBin, first.dir, second.dir);
    const reachability = env.path(env.ownBin, first.dir, second.dir);

    const plan = await planTakeover(env.ownRoot, detection, reachability, PLATFORM);
    expect(plan.kind).toBe('proceed');
    if (plan.kind !== 'proceed') return;

    const outcomes = await executeTakeover(plan.classifications);
    expect(outcomes.renames.map((c) => c.shimPath)).toEqual([first.shim]);
    expect(outcomes.deletes.map((c) => c.shimPath)).toEqual([second.shim]);
    expect(existsSync(join(first.dir, 'kimi-legacy'))).toBe(true);
    expect(existsSync(join(second.dir, 'kimi'))).toBe(false);
    expect(existsSync(join(second.dir, 'kimi-legacy'))).toBe(false);
  });

  it('consolidates onto an existing legacy kimi-legacy', async () => {
    const env = await makeEnv();
    const legacy = await makeLegacyShim('uvbin');
    await writeFile(
      join(legacy.dir, 'kimi-legacy'),
      '#!/bin/sh\n# older kimi_cli entry point\n',
      'utf-8',
    );

    const plan = await planTakeover(env.ownRoot, env.path(env.ownBin, legacy.dir), env.path(env.ownBin, legacy.dir), PLATFORM);
    expect(plan.kind).toBe('proceed');
    if (plan.kind !== 'proceed') return;

    const outcomes = await executeTakeover(plan.classifications);
    expect(outcomes.consolidates).toHaveLength(1);
    expect(existsSync(legacy.shim)).toBe(false);
    await expect(readFile(join(legacy.dir, 'kimi-legacy'), 'utf-8')).resolves.toContain(
      'older kimi_cli',
    );
  });

  it('leaves a user-managed kimi-legacy untouched (delete-only)', async () => {
    const env = await makeEnv();
    const legacy = await makeLegacyShim('uvbin');
    await writeFile(join(legacy.dir, 'kimi-legacy'), 'my own wrapper\n', 'utf-8');

    const plan = await planTakeover(env.ownRoot, env.path(env.ownBin, legacy.dir), env.path(env.ownBin, legacy.dir), PLATFORM);
    expect(plan.kind).toBe('proceed');
    if (plan.kind !== 'proceed') return;

    const outcomes = await executeTakeover(plan.classifications);
    expect(outcomes.skippedForeignTarget).toHaveLength(1);
    expect(outcomes.preserved).toBe(false);
    expect(existsSync(legacy.shim)).toBe(false);
    await expect(readFile(join(legacy.dir, 'kimi-legacy'), 'utf-8')).resolves.toBe(
      'my own wrapper\n',
    );
  });

  it('a failed preserve attempt gives the next shim its own preserve attempt', async () => {
    const env = await makeEnv();
    const first = await makeLegacyShim('uvbin');
    const second = await makeLegacyShim('pipxbin');

    const outcomes = await executeTakeover([
      {
        kind: 'renameable',
        shimPath: join(root, 'gone', 'kimi'),
        target: join(root, 'gone', 'kimi-legacy'),
        detection: { shimPath: join(root, 'gone', 'kimi'), realPath: '' },
      },
      {
        kind: 'renameable',
        shimPath: second.shim,
        target: join(second.dir, 'kimi-legacy'),
        detection: { shimPath: second.shim, realPath: second.shim },
      },
    ]);

    expect(outcomes.errors).toHaveLength(1);
    expect(outcomes.renames.map((c) => c.shimPath)).toEqual([second.shim]);
    expect(outcomes.deletes).toHaveLength(0);
    expect(outcomes.preserved).toBe(true);
    expect(existsSync(join(second.dir, 'kimi-legacy'))).toBe(true);
  });

  it('reports the takeover as not held when a shim survives ahead of ours', async () => {
    const env = await makeEnv();
    const legacy = await makeLegacyShim('uvbin');
    const reachability = env.path(legacy.dir, env.ownBin);

    const plan = await planTakeover(env.ownRoot, env.path(legacy.dir, env.ownBin), reachability, PLATFORM);
    expect(plan.kind).toBe('proceed');
    if (plan.kind !== 'proceed') return;

    const verify = await verifyTakeover(
      env.ownRoot,
      reachability,
      plan.classifications.map((c) => c.shimPath),
      PLATFORM,
    );
    expect(verify.kind).toBe('blocked-legacy');
  });

  it('aborts with kind=blocked when the shim dir is not writable', async () => {
    if (process.getuid?.() === 0) return;
    const env = await makeEnv();
    const legacy = await makeLegacyShim('sysbin');
    await chmod(legacy.dir, 0o555);
    try {
      const plan = await planTakeover(env.ownRoot, env.path(env.ownBin, legacy.dir), env.path(legacy.dir, env.ownBin), PLATFORM);
      expect(plan.kind).toBe('blocked');
      expect(existsSync(legacy.shim)).toBe(true);
    } finally {
      await chmod(legacy.dir, 0o755);
    }
  });

  it('aborts with kind=foreign when an unrecognized kimi wins resolution', async () => {
    const env = await makeEnv();
    const foreignDir = join(root, 'homebin');
    await mkdir(foreignDir, { recursive: true });
    await writeFile(join(foreignDir, 'kimi'), '#!/bin/sh\necho mine\n', 'utf-8');
    await chmod(join(foreignDir, 'kimi'), 0o755);
    const legacy = await makeLegacyShim('uvbin');

    const plan = await planTakeover(
      env.ownRoot,
      env.path(foreignDir, legacy.dir, env.ownBin),
      env.path(foreignDir, legacy.dir, env.ownBin),
      PLATFORM,
    );
    expect(plan.kind).toBe('foreign');
    expect(existsSync(legacy.shim)).toBe(true);
  });

  it('aborts with kind=not-on-path when our shim is not reachable', async () => {
    const env = await makeEnv();
    const legacy = await makeLegacyShim('uvbin');

    const plan = await planTakeover(env.ownRoot, env.path(env.ownBin, legacy.dir), env.path(legacy.dir), PLATFORM);
    expect(plan.kind).toBe('not-on-path');
    expect(existsSync(legacy.shim)).toBe(true);
  });

  it('returns noop when no legacy shim exists', async () => {
    const env = await makeEnv();
    const plan = await planTakeover(env.ownRoot, env.path(env.ownBin), env.path(env.ownBin), PLATFORM);
    expect(plan.kind).toBe('noop');
  });

  it('verifies none when every kimi is gone after execution', async () => {
    const env = await makeEnv();
    const verify = await verifyTakeover(env.ownRoot, env.path(join(root, 'emptybin')), [], PLATFORM);
    expect(verify.kind).toBe('none');
  });
});

describe('package-manager and own-root detection', () => {
  it('detects the package manager from npm_config_user_agent', () => {
    process.env['npm_config_user_agent'] = 'pnpm/9.1.0 npm/? node/v22.0.0 darwin arm64';
    expect(detectPackageManager()).toBe('pnpm');
    process.env['npm_config_user_agent'] = 'yarn/1.22.22 npm/? node/v22.0.0 darwin arm64';
    expect(detectPackageManager()).toBe('yarn');
    process.env['npm_config_user_agent'] = 'npm/11.0.0 node/v22.0.0 darwin arm64';
    expect(detectPackageManager()).toBe('npm');
  });

  it('gates on the documented global-install signals', () => {
    expect(isGlobalInstall()).toBe(false);
    process.env['npm_config_global'] = 'true';
    expect(isGlobalInstall()).toBe(true);
    delete process.env['npm_config_global'];
    process.env['npm_config_location'] = 'global';
    expect(isGlobalInstall()).toBe(true);
    delete process.env['npm_config_location'];
    process.env['pnpm_config_global'] = 'true';
    expect(isGlobalInstall()).toBe(true);
  });

  it('locates the own package root from a nested start dir', async () => {
    const pkg = join(root, 'pkgroot');
    await mkdir(join(pkg, 'scripts', 'postinstall'), { recursive: true });
    await writeFile(join(pkg, 'package.json'), '{}', 'utf-8');
    expect(await ownPackageRoot(join(pkg, 'scripts', 'postinstall'))).toBe(await realpath(pkg));
  });
});

describe('windows forms (platform injection, host-agnostic)', () => {
  it('expands PATHEXT candidates for kimi', () => {
    const candidates = executableCandidates('kimi', 'win32');
    expect(candidates).toContain('kimi');
    expect(candidates).toContain('kimi.exe');
    expect(candidates).toContain('kimi.cmd');
    expect(executableCandidates('kimi', 'linux')).toEqual(['kimi']);
  });

  it('preserves the extension in the rename target', () => {
    expect(renameTargetFor('C:\\Users\\me\\.local\\bin\\kimi.exe', 'win32')).toBe(
      'C:\\Users\\me\\.local\\bin\\kimi-legacy.exe',
    );
    expect(renameTargetFor('C:\\Users\\me\\.local\\bin\\kimi', 'win32')).toBe(
      'C:\\Users\\me\\.local\\bin\\kimi-legacy',
    );
    expect(renameTargetFor('/home/me/.local/bin/kimi', 'linux')).toBe(
      '/home/me/.local/bin/kimi-legacy',
    );
  });

  it('classifies system-owned dirs from drive-letter and UNC forms', async () => {
    await expect(isSystemOwnedDir('C:\\Program Files\\kimi\\kimi.exe', 'win32')).resolves.toBe(true);
    await expect(isSystemOwnedDir('c:\\programdata\\uv\\kimi.exe', 'win32')).resolves.toBe(true);
    await expect(isSystemOwnedDir('C:\\Users\\me\\.local\\bin\\kimi.exe', 'win32')).resolves.toBe(false);
    await expect(isSystemOwnedDir('D:\\tools\\kimi.exe', 'win32')).resolves.toBe(false);
    await expect(isSystemOwnedDir('\\\\server\\share\\tools\\kimi.exe', 'win32')).resolves.toBe(false);
  });
});
