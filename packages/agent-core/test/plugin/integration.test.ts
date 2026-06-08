import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PluginManager } from '../../src/plugin/manager';

describe('PluginManager → SkillRegistry integration', () => {
  it('enabled plugin contributes to pluginSkillRoots()', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'));
    const pluginRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'plugin-')));
    await writeFile(
      path.join(pluginRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', skills: './skills/' }),
      'utf8',
    );
    await mkdir(path.join(pluginRoot, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(
      path.join(pluginRoot, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: demo\n---\nbody',
      'utf8',
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(pluginRoot);
    const managedRoot = await realpath(path.join(home, 'plugins', 'managed', 'demo'));

    expect(manager.pluginSkillRoots()).toContainEqual({
      path: path.join(managedRoot, 'skills'),
      source: 'extra',
      plugin: { id: 'demo', instructions: undefined },
    });
  });
});
