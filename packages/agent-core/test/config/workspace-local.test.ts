import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { testKaos } from '../fixtures/test-kaos';
import { ErrorCodes, KimiError } from '../../src/errors';
import {
  appendWorkspaceAdditionalDir,
  loadWorkspaceLocalConfig,
  normalizeAdditionalDirs,
  readWorkspaceAdditionalDirs,
} from '../../src/config/workspace-local';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-workspace-local-'));
  tempDirs.push(root);
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, 'packages', 'app'), { recursive: true });
  return root;
}

async function expectConfigInvalid(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(KimiError);
  await expect(promise).rejects.toMatchObject({
    code: ErrorCodes.CONFIG_INVALID,
    message: expect.stringContaining(message),
  });
}

describe('workspace local config', () => {
  it('returns empty workspace config when local.toml is missing', async () => {
    const root = await makeProject();

    await expect(loadWorkspaceLocalConfig(testKaos, join(root, 'packages', 'app'))).resolves.toEqual({
      projectRoot: root,
      configPath: join(root, '.kimi-code', 'local.toml'),
      additionalDirs: [],
    });
  });

  it('loads additional_dir array from the project root when started nested', async () => {
    const root = await makeProject();
    const sharedDir = join(root, 'shared');
    const otherDir = join(root, 'other');
    await mkdir(sharedDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    await writeFile(
      join(root, '.kimi-code', 'local.toml'),
      '[workspace]\nadditional_dir = ["shared", "other"]\n',
      'utf-8',
    );

    await expect(readWorkspaceAdditionalDirs(testKaos, join(root, 'packages', 'app'))).resolves.toEqual({
      projectRoot: root,
      configPath: join(root, '.kimi-code', 'local.toml'),
      additionalDirs: [sharedDir, otherDir],
    });
  });

  it('rejects string additional_dir values', async () => {
    const root = await makeProject();
    await mkdir(join(root, 'shared'), { recursive: true });
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    await writeFile(
      join(root, '.kimi-code', 'local.toml'),
      '[workspace]\nadditional_dir = "shared"\n',
      'utf-8',
    );

    await expectConfigInvalid(
      loadWorkspaceLocalConfig(testKaos, join(root, 'packages', 'app')),
      'workspace.additional_dir must be an array of strings',
    );
  });

  it('rejects configured additional_dir that does not exist', async () => {
    const root = await makeProject();
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    await writeFile(
      join(root, '.kimi-code', 'local.toml'),
      '[workspace]\nadditional_dir = ["missing"]\n',
      'utf-8',
    );

    await expectConfigInvalid(
      readWorkspaceAdditionalDirs(testKaos, join(root, 'packages', 'app')),
      'workspace.additional_dir must exist and be a directory',
    );
  });

  it('appends multiple directories and deduplicates normalized paths', async () => {
    const root = await makeProject();
    const sharedDir = join(root, 'shared');
    const otherDir = join(root, 'other');
    await mkdir(sharedDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });

    const appended = await appendWorkspaceAdditionalDir(testKaos, root, 'shared', []);
    const configPath = join(root, '.kimi-code', 'local.toml');
    const before = await readFile(configPath, 'utf-8');

    const duplicate = await appendWorkspaceAdditionalDir(testKaos, root, './shared', []);
    const afterDuplicate = await readFile(configPath, 'utf-8');
    const second = await appendWorkspaceAdditionalDir(testKaos, root, 'other', duplicate.additionalDirs);

    expect(duplicate).toEqual(appended);
    expect(afterDuplicate).toBe(before);
    expect(second.additionalDirs).toEqual([sharedDir, otherDir]);
  });

  it('uses the actual local.toml state even when current dirs are empty', async () => {
    const root = await makeProject();
    const sharedDir = join(root, 'shared');
    const otherDir = join(root, 'other');
    await mkdir(sharedDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    const configPath = join(root, '.kimi-code', 'local.toml');
    await writeFile(configPath, '[workspace]\nadditional_dir = ["shared"]\n', 'utf-8');

    const result = await appendWorkspaceAdditionalDir(testKaos, root, 'other', []);

    expect(result.additionalDirs).toEqual([sharedDir, otherDir]);
  });

  it('does not rewrite local.toml when appending an existing directory', async () => {
    const root = await makeProject();
    const sharedDir = join(root, 'shared');
    await mkdir(sharedDir, { recursive: true });
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    const configPath = join(root, '.kimi-code', 'local.toml');
    const before = '[workspace]\nadditional_dir = ["shared"]\n';
    await writeFile(configPath, before, 'utf-8');

    const result = await appendWorkspaceAdditionalDir(testKaos, root, './shared', []);

    expect(result.additionalDirs).toEqual([sharedDir]);
    await expect(readFile(configPath, 'utf-8')).resolves.toBe(before);
  });

  it('rejects missing paths when appending additional_dir', async () => {
    const root = await makeProject();

    await expectConfigInvalid(
      appendWorkspaceAdditionalDir(testKaos, root, 'missing', []),
      'workspace.additional_dir must exist and be a directory',
    );
  });

  it('rejects non-directory paths when appending additional_dir', async () => {
    const root = await makeProject();
    await writeFile(join(root, 'shared'), 'not a directory', 'utf-8');

    await expectConfigInvalid(
      appendWorkspaceAdditionalDir(testKaos, root, 'shared', []),
      'workspace.additional_dir must exist and be a directory',
    );
  });

  it('deduplicates normalized additional dirs while preserving order', () => {
    expect(
      normalizeAdditionalDirs(['shared', './shared', 'nested//dir', 'nested/dir/../final']),
    ).toEqual(['shared', 'nested/dir', 'nested/final']);
  });
});
