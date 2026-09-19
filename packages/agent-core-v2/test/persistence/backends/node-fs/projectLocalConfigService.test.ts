import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';

import { stubBootstrap } from '../../../app/bootstrap/stubs';

describe('FileProjectLocalConfigService', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-project-local-config-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function createService(): FileProjectLocalConfigService {
    return new FileProjectLocalConfigService(stubBootstrap(), new HostFileSystem());
  }

  async function writeLocalToml(content: string): Promise<void> {
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(join(workDir, '.kimi-code', 'local.toml'), content, 'utf8');
  }

  it('returns no additional dirs when local.toml is missing', async () => {
    const result = await createService().readAdditionalDirs(workDir);
    expect(result.projectRoot).toBe(workDir);
    expect(result.configPath).toBe(join(workDir, '.kimi-code', 'local.toml'));
    expect(result.additionalDirs).toEqual([]);
  });

  it('resolves persisted additional dirs relative to the project root', async () => {
    const sibling = join(workDir, 'sibling');
    const outside = join(workDir, 'outside');
    await mkdir(sibling, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeLocalToml(`[workspace]\nadditional_dir = ["sibling", "${outside}"]\n`);

    const result = await createService().readAdditionalDirs(workDir);
    expect(result.additionalDirs).toEqual([sibling, outside]);
  });

  it('drops persisted entries that no longer exist on disk and keeps the valid ones', async () => {
    const alive = join(workDir, 'alive');
    await mkdir(alive, { recursive: true });
    const stale = join(workDir, 'deleted');
    await writeLocalToml(`[workspace]\nadditional_dir = ["deleted", "alive", "${stale}"]\n`);

    const result = await createService().readAdditionalDirs(workDir);
    expect(result.additionalDirs).toEqual([alive]);
  });

  it('drops persisted entries that exist but are not directories', async () => {
    const alive = join(workDir, 'alive');
    const fileEntry = join(workDir, 'notes.txt');
    await mkdir(alive, { recursive: true });
    await writeFile(fileEntry, 'not a directory', 'utf8');
    await writeLocalToml(`[workspace]\nadditional_dir = ["notes.txt", "alive"]\n`);

    const result = await createService().readAdditionalDirs(workDir);
    expect(result.additionalDirs).toEqual([alive]);
  });

  it('rejects invalid TOML with a storage decode error', async () => {
    await writeLocalToml('[workspace\nadditional_dir = [');
    await expect(createService().readAdditionalDirs(workDir)).rejects.toMatchObject({
      code: 'storage.decode_failed',
    });
  });

  it('appendAdditionalDir rejects a new path that does not exist', async () => {
    await writeLocalToml('[workspace]\nadditional_dir = []\n');
    await expect(
      createService().appendAdditionalDir(workDir, join(workDir, 'missing')),
    ).rejects.toMatchObject({ code: 'config.invalid' });
  });

  it('appendAdditionalDir rejects a new path that is not a directory', async () => {
    const fileEntry = join(workDir, 'notes.txt');
    await writeFile(fileEntry, 'not a directory', 'utf8');
    await expect(
      createService().appendAdditionalDir(workDir, fileEntry),
    ).rejects.toMatchObject({ code: 'config.invalid' });
  });

  it('appendAdditionalDir appends when the file already contains stale entries', async () => {
    await writeLocalToml('[workspace]\nadditional_dir = ["gone-dir"]\n');
    const fresh = join(workDir, 'fresh');
    await mkdir(fresh, { recursive: true });

    const result = await createService().appendAdditionalDir(workDir, 'fresh');
    expect(result.additionalDirs).toEqual([join(workDir, 'gone-dir'), fresh]);
    expect(await createService().readAdditionalDirs(workDir)).toMatchObject({
      additionalDirs: [fresh],
    });
  });
});
