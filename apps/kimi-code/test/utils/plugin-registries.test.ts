import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { addRegistry, readRegistries, removeRegistry, resolveRegistryUrl } from '#/utils/plugin-registries';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-registries-'));
  tempDirs.push(dir);
  return dir;
}

describe('plugin-registries', () => {
  it('reads an empty file when none exists', async () => {
    const homeDir = await makeTempDir();
    const file = await readRegistries(homeDir);
    expect(file).toEqual({ version: 1, registries: [] });
  });

  it('adds and lists registries', async () => {
    const homeDir = await makeTempDir();
    await addRegistry(homeDir, { url: 'https://example.com/m.json', name: 'example' });
    const file = await readRegistries(homeDir);
    expect(file.registries).toEqual([{ name: 'example', url: 'https://example.com/m.json' }]);
  });

  it('rejects duplicate URLs', async () => {
    const homeDir = await makeTempDir();
    await addRegistry(homeDir, { url: 'https://example.com/m.json' });
    await expect(addRegistry(homeDir, { url: 'https://example.com/m.json' })).rejects.toThrow(
      /already registered/,
    );
  });

  it('rejects duplicate names', async () => {
    const homeDir = await makeTempDir();
    await addRegistry(homeDir, { url: 'https://a.com/m.json', name: 'team' });
    await expect(
      addRegistry(homeDir, { url: 'https://b.com/m.json', name: 'team' }),
    ).rejects.toThrow(/already registered/);
  });

  it('removes by name then by URL fallback', async () => {
    const homeDir = await makeTempDir();
    await addRegistry(homeDir, { url: 'https://a.com/m.json', name: 'a' });
    await addRegistry(homeDir, { url: 'https://b.com/m.json' });

    await removeRegistry(homeDir, 'a');
    let file = await readRegistries(homeDir);
    expect(file.registries).toHaveLength(1);

    await removeRegistry(homeDir, 'https://b.com/m.json');
    file = await readRegistries(homeDir);
    expect(file.registries).toHaveLength(0);
  });

  it('resolves registry names and URLs', async () => {
    const homeDir = await makeTempDir();
    await addRegistry(homeDir, { url: 'https://named.com/m.json', name: 'named' });

    expect(await resolveRegistryUrl(homeDir, 'named')).toBe('https://named.com/m.json');
    expect(await resolveRegistryUrl(homeDir, 'https://direct.com/m.json')).toBe(
      'https://direct.com/m.json',
    );
    expect(await resolveRegistryUrl(homeDir, './marketplace.json')).toBe('./marketplace.json');
    expect(await resolveRegistryUrl(homeDir, '../marketplace.json')).toBe('../marketplace.json');
    await expect(resolveRegistryUrl(homeDir, 'missing')).rejects.toThrow(/not found/);
  });
});
