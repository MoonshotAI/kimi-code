/**
 * Scenario: plugin installation and consumption metadata through `PluginManager`.
 *
 * Verifies persisted plugin capabilities and skill counts against the real
 * filesystem discovery path. Network download boundaries are stubbed locally.
 * Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/plugin/manager-consumption.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginManager } from '#/app/plugin/manager';

import { stubSkill } from '../skillCatalog/stubs';

async function isolatedTmpdir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kimi-isolated-tmp-'));
  vi.stubEnv('TMPDIR', dir);
  return dir;
}

async function zipTempLeftovers(dir: string): Promise<readonly string[]> {
  return (await readdir(dir)).filter((entry) => entry.startsWith('kimi-plugin-zip-'));
}

async function makeKimiHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kimi-home-'));
}

async function managedPluginRoot(manager: PluginManager, id: string): Promise<string> {
  const root = manager.get(id)?.root;
  if (root === undefined) throw new Error(`Plugin "${id}" is not installed`);
  return realpath(root);
}

async function makePlugin(
  name: string,
  options: {
    skills?: boolean;
    skillNames?: readonly string[];
    version?: string;
    sessionStartSkill?: string;
    mcpServers?: Record<string, unknown>;
    hooks?: readonly unknown[];
    commands?: Record<string, string>;
  } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `plugin-${name}-`));
  const manifest: Record<string, unknown> = { name };
  if (options.version !== undefined) {
    manifest['version'] = options.version;
  }
  const skillNames = options.skillNames ?? (options.skills === true ? ['demo-skill'] : []);
  if (skillNames.length > 0) {
    manifest['skills'] = './skills/';
    await mkdir(path.join(root, 'skills'), { recursive: true });
    for (const skillName of skillNames) {
      await mkdir(path.join(root, 'skills', skillName), { recursive: true });
      await writeFile(
        path.join(root, 'skills', skillName, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: A demo\n---\nbody`,
        'utf8',
      );
    }
  }
  if (options.sessionStartSkill !== undefined) {
    manifest['sessionStart'] = { skill: options.sessionStartSkill };
  }
  if (options.mcpServers !== undefined) {
    manifest['mcpServers'] = options.mcpServers;
  }
  if (options.hooks !== undefined) {
    manifest['hooks'] = options.hooks;
  }
  if (options.commands !== undefined) {
    manifest['commands'] = ['./commands'];
    await mkdir(path.join(root, 'commands'), { recursive: true });
    for (const [file, body] of Object.entries(options.commands)) {
      const filePath = path.join(root, 'commands', file);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, body, 'utf8');
    }
  }
  await writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify(manifest), 'utf8');
  return realpath(root);
}

async function zipDir(sourceRoot: string): Promise<Buffer> {
  const zipPath = path.join(tmpdir(), `plugin-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceRoot });
  const buffer = await readFile(zipPath);
  await rm(zipPath, { force: true });
  return buffer;
}

async function serveOnce(buffer: Buffer): Promise<string> {
  const server = createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/zip' });
    res.end(buffer);
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('bad server address');
  return `http://127.0.0.1:${address.port}/plugin.zip`;
}

interface MockGithubFetchOptions {
  releaseTag?: string;
  tarball: Buffer;
  onReleaseLookup?: () => void;
}

function mockGithubFetch(options: MockGithubFetchOptions): void {
  const commitSha = '1111111111111111111111111111111111111111';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest$/.test(url)) {
        options.onReleaseLookup?.();
        if (options.releaseTag === undefined) {
          return new Response(null, { status: 404 });
        }
        const tagUrl = url.replace(/\/releases\/latest$/, `/releases/tag/${options.releaseTag}`);
        return new Response(null, { status: 302, headers: { location: tagUrl } });
      }
      if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/commits\/.+\.atom$/.test(url)) {
        return new Response(
          `<entry><id>tag:github.com,2008:Grit::Commit/${commitSha}</id></entry>`,
        );
      }
      if (url.startsWith('https://codeload.github.com/')) {
        if (init?.method === 'HEAD') return new Response(null, { status: 200 });
        return new Response(options.tarball, { status: 200 });
      }
      throw new Error(`mockGithubFetch: unexpected url ${url}`);
    }) as typeof fetch,
  );
}

describe('PluginManager consumption plane', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('pluginSkillRoots() returns only enabled plugins skills paths', async () => {
    const home = await makeKimiHome();
    const a = await makePlugin('a', { skills: true });
    const b = await makePlugin('b', { skills: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(a);
    await manager.install(b);
    await manager.setEnabled('b', false);
    const managedA = await managedPluginRoot(manager, 'a');
    const managedB = await managedPluginRoot(manager, 'b');
    expect(manager.pluginSkillRoots()).toContainEqual({
      path: path.join(managedA, 'skills'),
      source: 'extra',
      plugin: { id: 'a', instructions: undefined },
    });
    expect(manager.pluginSkillRoots()).not.toContainEqual({
      path: path.join(managedB, 'skills'),
      source: 'extra',
      plugin: { id: 'b', instructions: undefined },
    });
  });

  it('pluginSkillRoots() excludes plugins in error state', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await writeFile(
      path.join(await managedPluginRoot(manager, 'demo'), 'kimi.plugin.json'),
      '{ not json',
      'utf8',
    );
    await manager.reload();
    expect(manager.get('demo')?.state).toBe('error');
    expect(manager.pluginSkillRoots()).toEqual([]);
  });

  it('summaries count discovered skills inside plugin skill roots', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('superpowers', {
      skillNames: ['brainstorming', 'systematic-debugging', 'writing-plans'],
    });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.summaries()).toContainEqual(
      expect.objectContaining({ id: 'superpowers', skillCount: 3 }),
    );
    expect(manager.info('superpowers')?.skillCount).toBe(3);
  });

  it('reports the provided discovery result when skill counting is overridden', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('custom-discovery', {
      skillNames: ['first', 'second'],
    });
    const manager = new PluginManager({
      kimiHomeDir: home,
      discoverSkills: async () => ({
        skills: [stubSkill('provided')],
        skipped: [],
        scannedRoots: [],
      }),
    });
    await manager.load();
    await manager.install(root);
    expect(manager.info('custom-discovery')?.skillCount).toBe(1);
  });

  it('counts a SKILL.md at the plugin root fallback', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('root-skill-plugin');
    await writeFile(
      path.join(root, 'SKILL.md'),
      '---\nname: root-skill\ndescription: at root\n---\nbody',
      'utf8',
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.info('root-skill-plugin')?.skillCount).toBe(1);
  });

  it('counts nested sub-skills discovered through has-sub-skill bundles', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('nested', { skillNames: ['parent'] });
    await writeFile(
      path.join(root, 'skills', 'parent', 'SKILL.md'),
      '---\nname: parent\ndescription: p\nhas-sub-skill: true\n---\nbody',
      'utf8',
    );
    await mkdir(path.join(root, 'skills', 'parent', 'child'), { recursive: true });
    await writeFile(
      path.join(root, 'skills', 'parent', 'child', 'SKILL.md'),
      '---\nname: child\ndescription: c\n---\nbody',
      'utf8',
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.info('nested')?.skillCount).toBe(2);
  });

  it('does not count skills whose SKILL.md has invalid frontmatter', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('invalid-fm', { skillNames: ['good'] });
    await mkdir(path.join(root, 'skills', 'bad'), { recursive: true });
    await writeFile(path.join(root, 'skills', 'bad', 'SKILL.md'), 'no frontmatter at all', 'utf8');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.info('invalid-fm')?.skillCount).toBe(1);
  });

  it('dedupes same-named skills across multiple plugin skill roots', async () => {
    const home = await makeKimiHome();
    const root = await mkdtemp(path.join(tmpdir(), 'plugin-multiroot-'));
    await writeFile(
      path.join(root, 'kimi.plugin.json'),
      JSON.stringify({ name: 'multiroot', skills: ['./a/', './b/'] }),
      'utf8',
    );
    for (const dir of ['a', 'b']) {
      await mkdir(path.join(root, dir, 'dup'), { recursive: true });
      await writeFile(
        path.join(root, dir, 'dup', 'SKILL.md'),
        '---\nname: dup\ndescription: d\n---\nbody',
        'utf8',
      );
    }
    await mkdir(path.join(root, 'b', 'unique'), { recursive: true });
    await writeFile(
      path.join(root, 'b', 'unique', 'SKILL.md'),
      '---\nname: unique\ndescription: u\n---\nbody',
      'utf8',
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(await realpath(root));
    expect(manager.info('multiroot')?.skillCount).toBe(2);
    await rm(root, { recursive: true, force: true });
  });

  it('removes the zip temp dir when extraction of a corrupt zip fails', async () => {
    const home = await makeKimiHome();
    const isolated = await isolatedTmpdir();
    const url = await serveOnce(Buffer.from('this is not a zip archive'));
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await expect(manager.install(url)).rejects.toThrow();
    expect(await zipTempLeftovers(isolated)).toEqual([]);
    await rm(isolated, { recursive: true, force: true });
  });

  it('removes the zip temp dir and reports the original source when a zip plugin has no manifest', async () => {
    const home = await makeKimiHome();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'plugin-no-manifest-'));
    await writeFile(path.join(sourceRoot, 'README.md'), 'no manifest here', 'utf8');
    const isolated = await isolatedTmpdir();
    const url = await serveOnce(await zipDir(sourceRoot));
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    let message = '';
    await manager.install(url).catch((error: Error) => {
      message = error.message;
    });

    expect(message).toContain(url);
    expect(message).not.toContain('kimi-plugin-zip');
    expect(await zipTempLeftovers(isolated)).toEqual([]);
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(isolated, { recursive: true, force: true });
  });

  it('reports the GitHub URL when a GitHub plugin tarball has no manifest', async () => {
    const home = await makeKimiHome();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'plugin-gh-no-manifest-'));
    await writeFile(path.join(sourceRoot, 'README.md'), 'no manifest here', 'utf8');
    const isolated = await isolatedTmpdir();
    const source = 'https://github.com/example/no-manifest-plugin';
    mockGithubFetch({ releaseTag: 'v1.0.0', tarball: await zipDir(sourceRoot) });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    let message = '';
    await manager.install(source).catch((error: Error) => {
      message = error.message;
    });

    expect(message).toContain(`Cannot install plugin from ${source}:`);
    expect(message).not.toContain('kimi-plugin-zip');
    await rm(home, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(isolated, { recursive: true, force: true });
  });

  it('removes the zip temp dir when a GitHub plugin tarball has no manifest', async () => {
    const home = await makeKimiHome();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'plugin-gh-no-manifest-'));
    await writeFile(path.join(sourceRoot, 'README.md'), 'no manifest here', 'utf8');
    const isolated = await isolatedTmpdir();
    const source = 'https://github.com/example/no-manifest-plugin';
    mockGithubFetch({ releaseTag: 'v1.0.0', tarball: await zipDir(sourceRoot) });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    await expect(manager.install(source)).rejects.toThrow();

    expect(await zipTempLeftovers(isolated)).toEqual([]);
    await rm(home, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(isolated, { recursive: true, force: true });
  });

  it('reports the real local path when a local-path plugin has no manifest', async () => {
    const home = await makeKimiHome();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'plugin-no-manifest-'));
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    let message = '';
    await manager.install(sourceRoot).catch((error: Error) => {
      message = error.message;
    });

    expect(message).toContain(`Cannot install plugin at ${await realpath(sourceRoot)}`);
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it('removes the zip temp dir after a successful zip install', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('zip-demo');
    const isolated = await isolatedTmpdir();
    const url = await serveOnce(await zipDir(root));
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(url);
    expect(manager.get('zip-demo')?.state).toBe('ok');
    expect(await zipTempLeftovers(isolated)).toEqual([]);
    await rm(isolated, { recursive: true, force: true });
  });

  it('enabledSessionStarts() returns only enabled plugin sessionStart declarations', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { skills: true, sessionStartSkill: 'demo-skill' });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.enabledSessionStarts()).toEqual([{ pluginId: 'demo', skillName: 'demo-skill' }]);
    await manager.setEnabled('demo', false);
    expect(manager.enabledSessionStarts()).toEqual([]);
  });

  it('setMcpServerEnabled() persists explicit MCP server state with cwd + env + runtime name', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', {
      mcpServers: {
        finance: { command: 'finance-mcp' },
        docs: { url: 'https://example.com/mcp' },
        events: { transport: 'sse', url: 'https://example.com/sse' },
      },
    });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    const managedRoot = await managedPluginRoot(manager, 'demo');

    expect(manager.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({
        name: 'finance',
        runtimeName: 'plugin-demo:finance',
        enabled: true,
        command: 'finance-mcp',
      }),
    );
    expect(manager.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({
        name: 'events',
        runtimeName: 'plugin-demo:events',
        transport: 'sse',
        url: 'https://example.com/sse',
      }),
    );
    expect(manager.summaries()[0]).toEqual(
      expect.objectContaining({ mcpServerCount: 3, enabledMcpServerCount: 3 }),
    );

    expect(manager.enabledMcpServers()).toEqual(
      expect.objectContaining({
        'plugin-demo:finance': expect.objectContaining({
          command: 'finance-mcp',
          cwd: managedRoot,
          env: expect.objectContaining({ KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: managedRoot }),
        }),
        'plugin-demo:docs': expect.objectContaining({ url: 'https://example.com/mcp' }),
        'plugin-demo:events': expect.objectContaining({
          transport: 'sse',
          url: 'https://example.com/sse',
        }),
      }),
    );

    await manager.setMcpServerEnabled('demo', 'finance', false);
    expect(manager.enabledMcpServers()).not.toHaveProperty('plugin-demo:finance');
    expect(manager.summaries()[0]).toEqual(
      expect.objectContaining({ mcpServerCount: 3, enabledMcpServerCount: 2 }),
    );

    const reloaded = new PluginManager({ kimiHomeDir: home });
    await reloaded.load();
    expect(reloaded.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'finance', enabled: false }),
    );
  });

  it('merges manifest MCP enabled defaults with explicit user state', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', {
      mcpServers: { finance: { command: 'finance-mcp', enabled: false } },
    });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    expect(manager.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'finance', enabled: false }),
    );
    expect(manager.summaries()[0]).toEqual(
      expect.objectContaining({ mcpServerCount: 1, enabledMcpServerCount: 0 }),
    );
    expect(manager.enabledMcpServers()).toEqual({});

    await manager.setMcpServerEnabled('demo', 'finance', true);
    expect(manager.enabledMcpServers()).toEqual(
      expect.objectContaining({
        'plugin-demo:finance': expect.objectContaining({ command: 'finance-mcp', enabled: true }),
      }),
    );

    const reloaded = new PluginManager({ kimiHomeDir: home });
    await reloaded.load();
    expect(reloaded.info('demo')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'finance', enabled: true }),
    );
    expect(reloaded.enabledMcpServers()).toHaveProperty('plugin-demo:finance');
  });

  it('uses unambiguous runtime names for plugin MCP servers', async () => {
    const home = await makeKimiHome();
    const first = await makePlugin('a-b', { mcpServers: { c: { command: 'first-mcp' } } });
    const second = await makePlugin('a', { mcpServers: { 'b-c': { command: 'second-mcp' } } });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(first);
    await manager.install(second);
    expect(manager.info('a-b')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'c', runtimeName: 'plugin-a-b:c' }),
    );
    expect(manager.info('a')?.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'b-c', runtimeName: 'plugin-a:b-c' }),
    );
    const servers = manager.enabledMcpServers();
    expect(servers).toEqual(
      expect.objectContaining({
        'plugin-a-b:c': expect.objectContaining({ command: 'first-mcp' }),
        'plugin-a:b-c': expect.objectContaining({ command: 'second-mcp' }),
      }),
    );
    expect(Object.keys(servers)).toHaveLength(2);
  });

  it('enabledMcpServers() excludes disabled plugins', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { mcpServers: { finance: { command: 'finance-mcp' } } });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await manager.setMcpServerEnabled('demo', 'finance', true);
    await manager.setEnabled('demo', false);
    expect(manager.enabledMcpServers()).toEqual({});
  });

  it('setMcpServerEnabled() rejects unknown MCP servers', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await expect(manager.setMcpServerEnabled('demo', 'missing', true)).rejects.toThrow(
      /does not declare MCP server/i,
    );
  });

  it('reload() picks up edits to the managed plugin copy', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo');
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    const managedRoot = await managedPluginRoot(manager, 'demo');
    await writeFile(
      path.join(managedRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', version: '2.0.0' }),
      'utf8',
    );
    const summary = await manager.reload();
    expect(summary.errors).toEqual([]);
    expect(manager.get('demo')?.manifest?.version).toBe('2.0.0');
  });

  it('remove() clears the entry but does not delete the source directory', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { skills: true });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await manager.remove('demo');
    expect(manager.get('demo')).toBeUndefined();
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('enabledHooks() returns hooks from enabled plugins with cwd and env injected', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', {
      hooks: [{ event: 'PreToolUse', command: './hooks/guard.sh', timeout: 10 }],
    });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    const installedRoot = await managedPluginRoot(manager, 'demo');
    expect(manager.enabledHooks()).toEqual([
      {
        event: 'PreToolUse',
        command: './hooks/guard.sh',
        timeout: 10,
        cwd: installedRoot,
        env: { KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: installedRoot },
      },
    ]);
  });

  it('enabledHooks() excludes disabled plugins', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', { hooks: [{ event: 'PreToolUse', command: './x.sh' }] });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    await manager.setEnabled('demo', false);
    expect(manager.enabledHooks()).toEqual([]);
  });

  it('install() from /tree/<tag-shaped-ref> pins the resolved commit', async () => {
    const home = await makeKimiHome();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'plugin-gh-tag-'));
    await writeFile(
      path.join(sourceRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'pin-tag-demo', version: '5.1.0' }),
      'utf8',
    );
    const zipBuffer = await zipDir(sourceRoot);
    const commitSha = '1111111111111111111111111111111111111111';

    let codeloadPath = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/commits/v5.1.0.atom')) {
          return new Response(
            `<entry><id>tag:github.com,2008:Grit::Commit/${commitSha}</id></entry>`,
          );
        }
        if (url.startsWith('https://codeload.github.com/')) {
          codeloadPath = new URL(url).pathname;
          return new Response(zipBuffer, { status: 200 });
        }
        throw new Error(`unexpected url ${url}`);
      }) as typeof fetch,
    );

    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const record = await manager.install('https://github.com/obra/superpowers/tree/v5.1.0');
    expect(codeloadPath).toBe(`/obra/superpowers/zip/${commitSha}`);
    expect(record.github?.ref).toEqual({ kind: 'branch', value: 'v5.1.0' });
    expect(record.github?.installedSha).toBe(commitSha);
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it('install() from /releases/tag/<tag> pins the tag commit', async () => {
    const home = await makeKimiHome();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'plugin-gh-release-'));
    await writeFile(
      path.join(sourceRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'pin-tag-demo', version: '5.1.0' }),
      'utf8',
    );
    const zipBuffer = await zipDir(sourceRoot);
    const commitSha = '1111111111111111111111111111111111111111';

    let codeloadPath = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/commits/v5.1.0.atom')) {
          return new Response(
            `<entry><id>tag:github.com,2008:Grit::Commit/${commitSha}</id></entry>`,
          );
        }
        if (url.startsWith('https://codeload.github.com/')) {
          codeloadPath = new URL(url).pathname;
          return new Response(zipBuffer, { status: 200 });
        }
        throw new Error(`unexpected url ${url}`);
      }) as typeof fetch,
    );

    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const record = await manager.install('https://github.com/obra/superpowers/releases/tag/v5.1.0');
    expect(codeloadPath).toBe(`/obra/superpowers/zip/${commitSha}`);
    expect(record.github?.ref).toEqual({ kind: 'tag', value: 'v5.1.0' });
    expect(record.github?.installedSha).toBe(commitSha);
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it('install() from github /tree/<branch> bypasses the GitHub API', async () => {
    const home = await makeKimiHome();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'plugin-gh-branch-'));
    await writeFile(
      path.join(sourceRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'gh-demo', version: '5.1.0' }),
      'utf8',
    );
    const zipBuffer = await zipDir(sourceRoot);

    let releaseLookups = 0;
    mockGithubFetch({ tarball: zipBuffer, onReleaseLookup: () => releaseLookups++ });

    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const record = await manager.install('https://github.com/wbxl2000/superpowers/tree/main');
    expect(releaseLookups).toBe(0);
    expect(record.source).toBe('github');
    expect(record.github?.ref).toEqual({ kind: 'branch', value: 'main' });
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it('install() ignores forged marketplace context from legacy callers', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('rando', { version: '1.0.0' });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const record = await (manager.install as (source: string, options?: unknown) => Promise<unknown>)(
      root,
      { marketplace: { id: 'rando', tier: 'official' } },
    );
    expect((record as { marketplace?: unknown }).marketplace).toBeUndefined();
  });

  it('install() from github URL overwrites an existing zip-url install (CDN migration)', async () => {
    const home = await makeKimiHome();

    const cdnSource = await mkdtemp(path.join(tmpdir(), 'plugin-cdn-'));
    await writeFile(
      path.join(cdnSource, 'kimi.plugin.json'),
      JSON.stringify({ name: 'superpowers', version: '5.0.0' }),
      'utf8',
    );
    const cdnUrl = await serveOnce(await zipDir(cdnSource));

    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    const first = await manager.install(cdnUrl);
    expect(first.source).toBe('zip-url');
    await manager.setEnabled('superpowers', false);

    const ghSource = await mkdtemp(path.join(tmpdir(), 'plugin-gh-migrate-'));
    await writeFile(
      path.join(ghSource, 'kimi.plugin.json'),
      JSON.stringify({ name: 'superpowers', version: '5.1.0' }),
      'utf8',
    );
    mockGithubFetch({ releaseTag: 'v5.1.0', tarball: await zipDir(ghSource) });

    const updated = await manager.install('https://github.com/wbxl2000/superpowers');
    expect(updated.source).toBe('github');
    expect(updated.manifest?.version).toBe('5.1.0');
    expect(updated.enabled).toBe(false);
    expect(updated.installedAt).toBe(first.installedAt);
    expect(updated.originalSource).toBe('https://github.com/wbxl2000/superpowers');
    expect(updated.github?.ref).toEqual({ kind: 'tag', value: 'v5.1.0' });
    expect(manager.list()).toHaveLength(1);

    await rm(cdnSource, { recursive: true, force: true });
    await rm(ghSource, { recursive: true, force: true });
  });

  it('enabledMcpServers() runs stdio node plugins via the bundled Electron Node under an Electron host', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', {
      mcpServers: { data: { command: 'node', args: ['./bin/data.mjs'] } },
    });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);
    const managedRoot = await managedPluginRoot(manager, 'demo');

    const originalElectron = process.versions['electron'];
    process.versions['electron'] = '33.4.11';
    try {
      const server = manager.enabledMcpServers()['plugin-demo:data'];
      expect(server).toEqual(
        expect.objectContaining({
          command: process.execPath,
          args: ['./bin/data.mjs'],
          cwd: managedRoot,
          env: expect.objectContaining({
            KIMI_CODE_HOME: home,
            KIMI_PLUGIN_ROOT: managedRoot,
            ELECTRON_RUN_AS_NODE: '1',
          }),
        }),
      );
      // An Electron host must not be routed through the CLI's `__plugin_run_node`
      // subcommand (which only the CLI binary implements).
      expect(JSON.stringify(server)).not.toContain('__plugin_run_node');
    } finally {
      if (originalElectron === undefined) delete process.versions['electron'];
      else process.versions['electron'] = originalElectron;
    }
  });

  it('enabledMcpServers() leaves stdio node plugins on system node outside Electron / CLI binary', async () => {
    const home = await makeKimiHome();
    const root = await makePlugin('demo', {
      mcpServers: { data: { command: 'node', args: ['./bin/data.mjs'] } },
    });
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();
    await manager.install(root);

    // Plain node host (tests run under node): not Electron, not the CLI native
    // binary, so the config passes through unchanged (command stays `node`).
    const server = manager.enabledMcpServers()['plugin-demo:data'];
    expect(server).toEqual(
      expect.objectContaining({
        command: 'node',
        args: ['./bin/data.mjs'],
      }),
    );
    expect(JSON.stringify(server)).not.toContain('ELECTRON_RUN_AS_NODE');
  });
});
