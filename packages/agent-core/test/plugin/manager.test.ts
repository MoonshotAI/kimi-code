import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PluginManager } from '../../src/plugin/manager';

async function makeKimiHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kimi-home-'));
}

async function makePlugin(name: string, options: { skills?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `plugin-${name}-`));
  await mkdir(path.join(root, '.kimi-plugin'), { recursive: true });
  const manifest: Record<string, unknown> = { name };
  if (options.skills === true) {
    manifest['skills'] = './skills/';
    await mkdir(path.join(root, 'skills'), { recursive: true });
    await mkdir(path.join(root, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(
      path.join(root, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: A demo\n---\nbody',
      'utf8',
    );
  }
  await writeFile(
    path.join(root, '.kimi-plugin', 'plugin.json'),
    JSON.stringify(manifest),
    'utf8',
  );
  return await realpath(root);
}

describe('PluginManager', () => {
  it('install() adds a plugin and load() rehydrates it from disk', async () => {
    const home = await makeKimiHome();
    const pluginRoot = await makePlugin('demo', { skills: true });

    let manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    expect(manager.list()).toEqual([]);

    const record = await manager.install(pluginRoot);
    expect(record.id).toBe('demo');
    expect(record.enabled).toBe(true);
    expect(manager.list()).toHaveLength(1);

    manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    expect(manager.list()).toHaveLength(1);
    expect(manager.get('demo')?.root).toBe(pluginRoot);
  });

  it('setEnabled() persists the new state', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { skills: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);

    await manager.setEnabled('demo', false);
    expect(manager.get('demo')?.enabled).toBe(false);

    const reloaded = new PluginManager({ kimiHomeDir: home });
    await reloaded.load();
    expect(reloaded.get('demo')?.enabled).toBe(false);
  });

  it('remove() clears the entry but does not delete the source directory', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { skills: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);

    await manager.remove('demo');
    expect(manager.get('demo')).toBeUndefined();
    // Source directory survives.
    const { stat } = await import('node:fs/promises');
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('enabledSkillDirs() returns only enabled plugins skills paths', async () => {
    const home = await makeKimiHome();
    const a = await makePlugin('a', { skills: true });
    const b = await makePlugin('b', { skills: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(a);
    await manager.install(b);
    await manager.setEnabled('b', false);
    const dirs = manager.enabledSkillDirs();
    expect(dirs).toContain(path.join(a, 'skills'));
    expect(dirs).not.toContain(path.join(b, 'skills'));
  });

  it('reload() picks up an in-place manifest edit', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);

    await writeFile(
      path.join(root, '.kimi-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '2.0.0' }),
      'utf8',
    );
    const summary = await manager.reload();
    expect(summary.errors).toEqual([]);
    expect(manager.get('demo')?.manifest?.version).toBe('2.0.0');
  });

  it('install() refuses to add a directory without a manifest', async () => {
    const home = await makeKimiHome();
    const root = await mkdtemp(path.join(tmpdir(), 'no-manifest-'));
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await expect(manager.install(root)).rejects.toThrow(/manifest/i);
  });

  it('install() refuses to add the same plugin twice', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await expect(manager.install(root)).rejects.toThrow(/already installed/i);
  });

  it('keeps a plugin in error state instead of losing it on a broken manifest', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await writeFile(
      path.join(root, '.kimi-plugin', 'plugin.json'),
      '{ not json',
      'utf8',
    );
    await manager.reload();
    const record = manager.get('demo');
    expect(record?.state).toBe('error');
    expect(record?.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.invalid_json' }),
    );
    expect(manager.enabledSkillDirs()).toEqual([]);
  });
});
