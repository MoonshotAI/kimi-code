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
  readSubagentBinding,
  readSubagentBindings,
  readSubagentSlotBinding,
  readSubagentSlotBindings,
  readWorkspaceAdditionalDirs,
  writeSubagentBinding,
  writeSubagentSlotBinding,
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

  it('resolves an appended relative path against workDir, not the project root', async () => {
    const root = await makeProject();
    const appDir = join(root, 'packages', 'app');
    const sharedDir = join(root, 'packages', 'shared');
    await mkdir(sharedDir, { recursive: true });

    const result = await appendWorkspaceAdditionalDir(testKaos, appDir, '../shared', []);

    expect(result.additionalDirs).toEqual([sharedDir]);
  });

  it('expands a ~/ path to the home directory when appending', async () => {
    const root = await makeProject();
    const homeDir = testKaos.gethome();
    const homeProjectDir = await mkdtemp(join(homeDir, 'kimi-workspace-local-home-'));
    tempDirs.push(homeProjectDir);
    const sharedDir = join(homeProjectDir, 'shared');
    await mkdir(sharedDir, { recursive: true });
    const tildePath = `~/${sharedDir.slice(homeDir.length + 1)}`;

    const result = await appendWorkspaceAdditionalDir(testKaos, root, tildePath, []);

    expect(result.additionalDirs).toEqual([sharedDir]);
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

describe('subagent bindings', () => {
  it('returns undefined when no binding exists for the type', async () => {
    const root = await makeProject();

    await expect(
      readSubagentBinding(testKaos, join(root, 'packages', 'app'), 'coder'),
    ).resolves.toBeUndefined();
    await expect(readSubagentBindings(testKaos, root)).resolves.toEqual({});
  });

  it('writes and reads back a model/effort binding', async () => {
    const root = await makeProject();
    const workDir = join(root, 'packages', 'app');

    const { configPath } = await writeSubagentBinding(testKaos, workDir, 'coder', {
      model: 'kimi-code/kimi-for-coding',
      thinkingEffort: 'high',
    });

    expect(configPath).toBe(join(root, '.kimi-code', 'local.toml'));
    await expect(readSubagentBinding(testKaos, workDir, 'coder')).resolves.toEqual({
      model: 'kimi-code/kimi-for-coding',
      thinkingEffort: 'high',
      inherit: undefined,
    });
    await expect(readSubagentBinding(testKaos, workDir, 'explore')).resolves.toBeUndefined();
    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('[subagent.coder]');
    expect(text).toContain('model = "kimi-code/kimi-for-coding"');
    expect(text).toContain('thinking_effort = "high"');
  });

  it('records an explicit inherit choice', async () => {
    const root = await makeProject();

    await writeSubagentBinding(testKaos, root, 'explore', { inherit: true });

    await expect(readSubagentBinding(testKaos, root, 'explore')).resolves.toEqual({
      model: undefined,
      thinkingEffort: undefined,
      inherit: true,
    });
  });

  it('preserves unrelated local.toml content and other type bindings', async () => {
    const root = await makeProject();
    const sharedDir = join(root, 'shared');
    await mkdir(sharedDir, { recursive: true });
    const configPath = join(root, '.kimi-code', 'local.toml');
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    await writeFile(configPath, '[workspace]\nadditional_dir = ["shared"]\n', 'utf-8');
    await writeSubagentBinding(testKaos, root, 'explore', { model: 'sub2/glm-5.2-x' });

    await writeSubagentBinding(testKaos, root, 'coder', { model: 'kimi-code/k3' });

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('[workspace]');
    expect(text).toContain('"shared"');
    expect(text).toContain('[subagent.explore]');
    expect(text).toContain('[subagent.coder]');
    await expect(readSubagentBindings(testKaos, root)).resolves.toEqual({
      explore: { model: 'sub2/glm-5.2-x', thinkingEffort: undefined, inherit: undefined },
      coder: { model: 'kimi-code/k3', thinkingEffort: undefined, inherit: undefined },
    });
  });

  it('clears a binding and drops the empty subagent table', async () => {
    const root = await makeProject();
    await writeSubagentBinding(testKaos, root, 'coder', { model: 'kimi-code/k3' });

    await writeSubagentBinding(testKaos, root, 'coder', undefined);

    await expect(readSubagentBinding(testKaos, root, 'coder')).resolves.toBeUndefined();
    const text = await readFile(join(root, '.kimi-code', 'local.toml'), 'utf-8');
    expect(text).not.toContain('subagent');
  });

  it('writes and reads back a named slot binding', async () => {
    const root = await makeProject();

    const { configPath } = await writeSubagentSlotBinding(testKaos, root, 'debater_a', {
      model: 'deepseek/deepseek-v4',
      thinkingEffort: 'high',
    });

    expect(configPath).toBe(join(root, '.kimi-code', 'local.toml'));
    await expect(readSubagentSlotBinding(testKaos, root, 'debater_a')).resolves.toEqual({
      model: 'deepseek/deepseek-v4',
      thinkingEffort: 'high',
      inherit: undefined,
    });
    // Slot storage is independent from the type-binding table.
    await expect(readSubagentBinding(testKaos, root, 'debater_a')).resolves.toBeUndefined();
    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('[subagent-slot.debater_a]');
    expect(text).toContain('model = "deepseek/deepseek-v4"');
  });

  it('keeps slot bindings and type bindings side by side and clears slots independently', async () => {
    const root = await makeProject();
    await writeSubagentBinding(testKaos, root, 'coder', { model: 'kimi-code/k3' });
    await writeSubagentSlotBinding(testKaos, root, 'debater_a', { model: 'deepseek/deepseek-v4' });
    await writeSubagentSlotBinding(testKaos, root, 'debater_b', { model: 'openrouter/claude' });

    await expect(readSubagentSlotBindings(testKaos, root)).resolves.toEqual({
      debater_a: { model: 'deepseek/deepseek-v4', thinkingEffort: undefined, inherit: undefined },
      debater_b: { model: 'openrouter/claude', thinkingEffort: undefined, inherit: undefined },
    });
    await expect(readSubagentBinding(testKaos, root, 'coder')).resolves.toMatchObject({
      model: 'kimi-code/k3',
    });

    await writeSubagentSlotBinding(testKaos, root, 'debater_a', undefined);

    await expect(readSubagentSlotBinding(testKaos, root, 'debater_a')).resolves.toBeUndefined();
    await expect(readSubagentSlotBinding(testKaos, root, 'debater_b')).resolves.toMatchObject({
      model: 'openrouter/claude',
    });
    const text = await readFile(join(root, '.kimi-code', 'local.toml'), 'utf-8');
    expect(text).toContain('[subagent.coder]');
    expect(text).not.toContain('debater_a');
  });
});
