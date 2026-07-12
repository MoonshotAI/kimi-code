/**
 * Scenario: core `PluginManager` installation and management behavior.
 *
 * Exercises the real filesystem store and managed copies; local HTTP and
 * stubbed `fetch` boundaries cover zip and GitHub sources.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/app/plugin/manager.test.ts
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginManager } from '#/app/plugin/manager';

describe('PluginManager', () => {
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'plugin-manager-home-'));
    root = await mkdtemp(join(tmpdir(), 'plugin-manager-root-'));
    await mkdir(join(home, 'plugins'), { recursive: true });
    await mkdir(join(root, 'commands'), { recursive: true });
    await writeFile(join(root, 'commands', 'deploy.md'), '---\ndescription: Deploy\n---\n\nBody', 'utf8');
    await writeFile(
      join(root, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'demo',
        commands: ['./commands'],
        hooks: [{ event: 'Stop', command: 'echo stop' }],
      }),
      'utf8',
    );
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root,
            source: 'local-path',
            enabled: true,
            installedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it('loads installed plugins and exposes summaries, hooks, and commands', async () => {
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    expect(manager.summaries()).toEqual([
      expect.objectContaining({
        id: 'demo',
        state: 'ok',
        commandCount: 1,
        hookCount: 1,
      }),
    ]);
    expect(manager.enabledHooks()).toEqual([
      {
        event: 'Stop',
        command: 'echo stop',
        cwd: root,
        env: { KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: root },
      },
    ]);
    await expect(manager.enabledCommands()).resolves.toEqual([
      expect.objectContaining({ pluginId: 'demo', name: 'deploy', description: 'Deploy' }),
    ]);
  });

  it('installs a local-path plugin into the managed root', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'plugin-install-source-'));
    try {
      await writeFile(join(sourceRoot, 'kimi.plugin.json'), JSON.stringify({ name: 'other' }), 'utf8');
      const manager = new PluginManager({ kimiHomeDir: home });

      const record = await manager.install(sourceRoot);

      expect(record.id).toBe('other');
      expect(record.root).toContain(join(home, 'plugins', 'managed', 'other'));
      expect(manager.get('other')?.manifest?.name).toBe('other');
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it('installs a zip-url plugin', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'plugin-zip-source-'));
    const zipPath = join(tmpdir(), `plugin-${Date.now()}.zip`);
    const server = createServer((_req, res) => {
      void readFile(zipPath).then((data) => res.end(data));
    });
    try {
      await writeFile(join(sourceRoot, 'kimi.plugin.json'), JSON.stringify({ name: 'zip-plugin' }), 'utf8');
      execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceRoot });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('bad server address');
      const manager = new PluginManager({ kimiHomeDir: home });

      const record = await manager.install(`http://127.0.0.1:${address.port}/plugin.zip`);

      expect(record.id).toBe('zip-plugin');
      expect(record.source).toBe('zip-url');
      expect(manager.get('zip-plugin')?.manifest?.name).toBe('zip-plugin');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err === undefined ? resolve() : reject(err))));
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(zipPath, { force: true });
    }
  });

  it('installs a github plugin through codeload', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'plugin-github-source-'));
    const zipPath = join(tmpdir(), `plugin-github-${Date.now()}.zip`);
    try {
      await writeFile(join(sourceRoot, 'kimi.plugin.json'), JSON.stringify({ name: 'github-plugin' }), 'utf8');
      execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceRoot });
      const zip = await readFile(zipPath);
      const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/commits/v1.atom')) {
          return new Response(
            '<entry><id>tag:github.com,2008:Grit::Commit/1111111111111111111111111111111111111111</id></entry>',
          );
        }
        return new Response(zip);
      });
      vi.stubGlobal('fetch', fetchMock as typeof fetch);
      const manager = new PluginManager({ kimiHomeDir: home });

      const record = await manager.install('https://github.com/owner/repo/tree/v1');

      expect(record.id).toBe('github-plugin');
      expect(record.source).toBe('github');
      expect(record.github).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: { kind: 'branch', value: 'v1' },
        installedSha: '1111111111111111111111111111111111111111',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://codeload.github.com/owner/repo/zip/1111111111111111111111111111111111111111',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const stored = JSON.parse(
        await readFile(join(home, 'plugins', 'installed.json'), 'utf8'),
      ) as { plugins: Array<{ id: string; github?: { installedSha?: string } }> };
      expect(stored.plugins.find((plugin) => plugin.id === 'github-plugin')?.github?.installedSha)
        .toBe('1111111111111111111111111111111111111111');
      expect(manager.get('github-plugin')?.manifest?.name).toBe('github-plugin');
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(zipPath, { force: true });
    }
  });

  it('checks github plugin updates against latest release', async () => {
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root,
            source: 'github',
            enabled: true,
            installedAt: '2026-01-01T00:00:00.000Z',
            originalSource: 'https://github.com/owner/repo',
            github: { owner: 'owner', repo: 'repo', ref: { kind: 'branch', value: 'v1' } },
          },
        ],
      }),
      'utf8',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 302,
        ok: false,
        headers: new Headers({ location: 'https://github.com/owner/repo/releases/tag/v2' }),
      }),
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    await expect(manager.checkUpdates()).resolves.toEqual([
      {
        id: 'demo',
        source: 'github',
        current: { kind: 'branch', value: 'v1' },
        latest: { kind: 'tag', value: 'v2' },
        displayVersion: 'v2',
        updateAvailable: true,
      },
    ]);
  });

  it('reports a pinned branch update only when its commit advances', async () => {
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root,
            source: 'github',
            enabled: true,
            installedAt: '2026-01-01T00:00:00.000Z',
            originalSource: 'https://github.com/owner/repo/tree/main',
            github: {
              owner: 'owner',
              repo: 'repo',
              ref: { kind: 'branch', value: 'main' },
              installedSha: '1111111111111111111111111111111111111111',
            },
          },
        ],
      }),
      'utf8',
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            '<entry><id>tag:github.com,2008:Grit::Commit/1111111111111111111111111111111111111111</id></entry>',
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            '<entry><id>tag:github.com,2008:Grit::Commit/2222222222222222222222222222222222222222</id></entry>',
          ),
        ),
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    await expect(manager.checkUpdates()).resolves.toEqual([
      expect.objectContaining({ id: 'demo', updateAvailable: false }),
    ]);
    await expect(manager.checkUpdates()).resolves.toEqual([
      expect.objectContaining({
        id: 'demo',
        current: { kind: 'branch', value: 'main' },
        latest: { kind: 'branch', value: 'main' },
        updateAvailable: true,
      }),
    ]);
  });

  it('treats legacy commit metadata without originalSource as pinned', async () => {
    const sha = '1111111111111111111111111111111111111111';
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root,
            source: 'github',
            enabled: true,
            installedAt: '2026-01-01T00:00:00.000Z',
            github: { owner: 'owner', repo: 'repo', ref: { kind: 'sha', value: sha } },
          },
        ],
      }),
      'utf8',
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    await expect(manager.checkUpdates()).resolves.toEqual([
      expect.objectContaining({
        id: 'demo',
        latest: { kind: 'sha', value: sha },
        updateAvailable: false,
      }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps successful update results when another repository lookup fails', async () => {
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: ['good', 'offline'].map((id) => ({
          id,
          root,
          source: 'github',
          enabled: true,
          installedAt: '2026-01-01T00:00:00.000Z',
          github: {
            owner: 'owner',
            repo: id,
            ref: { kind: 'tag', value: 'v1' },
          },
        })),
      }),
      'utf8',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/offline/')) throw new Error('network offline');
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/owner/good/releases/tag/v2' },
        });
      }) as typeof fetch,
    );
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    await expect(manager.checkUpdates()).resolves.toEqual([
      expect.objectContaining({ id: 'good', updateAvailable: true }),
    ]);
  });

  it('persists enabled state changes', async () => {
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    await manager.setEnabled('demo', false);

    expect(manager.get('demo')?.enabled).toBe(false);
    const stored = JSON.parse(await readFile(join(home, 'plugins', 'installed.json'), 'utf8')) as {
      plugins: Array<{ id: string; enabled: boolean }>;
    };
    expect(stored.plugins).toEqual([expect.objectContaining({ id: 'demo', enabled: false })]);
  });
});
