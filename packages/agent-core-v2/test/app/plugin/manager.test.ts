import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginManager } from '#/app/plugin/manager';
import { discoverFileSkills } from '#/features/skill/catalog/fileSkillDiscovery';

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

  async function makeZip(
    id: string,
    version = '1.0.0',
    skillName?: string,
    customize?: (sourceRoot: string) => Promise<void>,
  ): Promise<{ dir: string; buffer: Buffer }> {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-zip-fixture-'));
    const sourceRoot = join(dir, 'source');
    await mkdir(sourceRoot);
    await writeFile(
      join(sourceRoot, 'kimi.plugin.json'),
      JSON.stringify({
        name: id,
        version,
        skills: skillName === undefined ? undefined : ['./skills'],
      }),
      'utf8',
    );
    if (skillName !== undefined) {
      const skillDir = join(sourceRoot, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: Test skill\n---\n\nBody`,
        'utf8',
      );
    }
    await customize?.(sourceRoot);
    const zipPath = join(dir, 'plugin.zip');
    execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceRoot });
    return { dir, buffer: await readFile(zipPath) };
  }

  async function makeLegacyWebbridge(): Promise<string> {
    const legacyRoot = await mkdtemp(join(tmpdir(), 'plugin-legacy-webbridge-'));
    await writeFile(
      join(legacyRoot, 'kimi.plugin.json'),
      JSON.stringify({ name: 'kimi-webbridge', version: '1.0.0' }),
      'utf8',
    );
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'kimi-webbridge',
            root: legacyRoot,
            source: 'zip-url',
            origin: 'marketplace',
            catalogId: 'kimi-webbridge',
            enabled: false,
            installedAt: '2020-01-01T00:00:00.000Z',
            capabilities: { mcpServers: { mac: { enabled: false } } },
          },
        ],
      }),
      'utf8',
    );
    return legacyRoot;
  }

  function installWebbridge(
    manager: PluginManager,
    fixture: { readonly buffer: Buffer },
  ): ReturnType<PluginManager['installAndReload']> {
    return manager.installAndReload('https://example.test/kimi-browser-extension.zip', {
      expectedSha256: createHash('sha256').update(fixture.buffer).digest('hex'),
      expectedPluginId: 'kimi-browser-extension',
      origin: 'marketplace',
      catalogId: 'kimi-browser-extension',
      migrateFrom: 'kimi-webbridge',
      requiredSkill: 'kimi-webbridge',
      fetchImpl: async () => new Response(fixture.buffer),
    });
  }

  it('loads installed plugins and exposes summaries, hooks, and commands', async () => {
    const manager = new PluginManager({ kimiHomeDir: home });
    await manager.load();

    expect(manager.summaries()).toEqual([
      expect.objectContaining({
        id: 'demo',
        state: 'ok',
        origin: 'unknown',
        installedAt: '2026-01-01T00:00:00.000Z',
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

  it('applies interface overrides and locale translations without changing capability identifiers', async () => {
    await mkdir(join(root, 'skills', 'directory-skill'), { recursive: true });
    await writeFile(
      join(root, 'skills', 'directory-skill', 'SKILL.md'),
      '---\nname: runtime-skill\ndescription: Original skill description\n---\n\nBody',
      'utf8',
    );
    await writeFile(
      join(root, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'demo',
        skills: ['./skills'],
        interface: {
          defaultLocale: 'zh-CN',
          locales: './locales/',
          mcpOverrides: {
            mac: {
              displayName: 'Friendly MCP',
              description: 'Friendly MCP description',
              iconUrl: 'https://example.com/friendly-mcp.png',
            },
          },
          skillOverrides: {
            'directory-skill': {
              displayName: 'Friendly skill',
              description: 'Friendly skill description',
            },
          },
        },
        mcpServers: {
          mac: { command: 'sh', args: ['./bin/kimi-cu-mcp'] },
        },
      }),
      'utf8',
    );
    await mkdir(join(root, 'locales'), { recursive: true });
    await writeFile(
      join(root, 'locales', 'en-US.json'),
      JSON.stringify({
        mcpOverrides: {
          mac: {
            displayName: 'English MCP',
            description: 'English MCP description',
          },
        },
        skillOverrides: {
          'directory-skill': {
            displayName: 'English skill',
            description: 'English skill description',
          },
        },
      }),
      'utf8',
    );
    const manager = new PluginManager({ kimiHomeDir: home });

    await manager.load();
    const info = manager.info('demo');
    const english = manager.info('demo', 'en');

    expect(info?.skills).toEqual([
      {
        name: 'runtime-skill',
        displayName: 'Friendly skill',
        description: 'Friendly skill description',
      },
    ]);
    expect(info?.mcpServers[0]).toMatchObject({
      name: 'mac',
      displayName: 'Friendly MCP',
      description: 'Friendly MCP description',
      iconUrl: 'https://example.com/friendly-mcp.png',
      runtimeName: 'plugin-demo:mac',
      transport: 'stdio',
      command: 'sh',
    });
    expect(english?.skills).toEqual([
      {
        name: 'runtime-skill',
        displayName: 'English skill',
        description: 'English skill description',
      },
    ]);
    expect(english?.mcpServers[0]).toMatchObject({
      name: 'mac',
      displayName: 'English MCP',
      description: 'English MCP description',
      iconUrl: 'https://example.com/friendly-mcp.png',
      runtimeName: 'plugin-demo:mac',
      transport: 'stdio',
      command: 'sh',
    });
    expect(info?.manifest?.interface?.skillOverrides?.['directory-skill']?.displayName).toBe(
      'Friendly skill',
    );
    expect(info?.manifest?.interface?.mcpOverrides?.['mac']?.iconUrl).toBe(
      'https://example.com/friendly-mcp.png',
    );
  });

  it('reuses cached archives and inspections across locales, restarts, and installation', async () => {
    const fixture = await makeZip('cache-demo', '1.0.0', 'cache-skill', async (sourceRoot) => {
      await mkdir(join(sourceRoot, 'locales'), { recursive: true });
      await writeFile(
        join(sourceRoot, 'kimi.plugin.json'),
        JSON.stringify({
          name: 'cache-demo',
          version: '1.0.0',
          skills: ['./skills'],
          interface: {
            locales: './locales/',
            skillOverrides: {
              'cache-skill': { displayName: '默认技能', description: '默认描述' },
            },
          },
        }),
        'utf8',
      );
      await writeFile(
        join(sourceRoot, 'locales', 'en-US.json'),
        JSON.stringify({
          skillOverrides: {
            'cache-skill': { displayName: 'English skill', description: 'English description' },
          },
        }),
        'utf8',
      );
    });
    try {
      const sha256sum = createHash('sha256').update(fixture.buffer).digest('hex');
      const source = 'https://example.test/cache-demo.zip';
      const fetchImpl = vi.fn(async () => new Response(fixture.buffer)) as unknown as typeof fetch;
      const discoverSkills = vi.fn(discoverFileSkills);
      const options = { expectedSha256: sha256sum, expectedPluginId: 'cache-demo', fetchImpl };
      const manager = new PluginManager({ kimiHomeDir: home, discoverSkills });

      const chinese = await manager.inspect(source, { ...options, locale: 'zh-CN' });
      const english = await manager.inspect(source, { ...options, locale: 'en-US' });

      expect(chinese.skills[0]).toMatchObject({ displayName: '默认技能', description: '默认描述' });
      expect(english.skills[0]).toMatchObject({
        displayName: 'English skill',
        description: 'English description',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(discoverSkills).toHaveBeenCalledTimes(1);
      const archivePath = join(home, 'plugins', 'cache', 'archives', `${sha256sum}.zip`);
      await expect(readFile(archivePath)).resolves.toEqual(fixture.buffer);

      const restarted = new PluginManager({ kimiHomeDir: home, discoverSkills });
      const afterRestart = await restarted.inspect(source, { ...options, locale: 'en-US' });

      expect(afterRestart.skills[0]).toMatchObject({ displayName: 'English skill' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(discoverSkills).toHaveBeenCalledTimes(2);

      await restarted.install(source, options);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(restarted.get('cache-demo')?.manifest?.version).toBe('1.0.0');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('shares one in-flight archive download across concurrent previews and installation', async () => {
    const fixture = await makeZip('concurrent-cache', '1.0.0', 'concurrent-skill');
    try {
      const sha256sum = createHash('sha256').update(fixture.buffer).digest('hex');
      let resolveResponse!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      const fetchImpl = vi.fn(() => response) as unknown as typeof fetch;
      const source = 'https://example.test/concurrent-cache.zip';
      const options = { expectedSha256: sha256sum, expectedPluginId: 'concurrent-cache', fetchImpl };
      const manager = new PluginManager({ kimiHomeDir: home });

      const chinese = manager.inspect(source, { ...options, locale: 'zh-CN' });
      const english = manager.inspect(source, { ...options, locale: 'en-US' });
      const installation = manager.install(source, options);
      try {
        await vi.waitFor(() => {
          expect(fetchImpl).toHaveBeenCalledTimes(1);
        });
      } finally {
        resolveResponse(new Response(fixture.buffer));
      }
      const [chineseResult, englishResult, installed] = await Promise.all([
        chinese,
        english,
        installation,
      ]);

      expect(chineseResult.skills[0]?.name).toBe('concurrent-skill');
      expect(englishResult.skills[0]?.name).toBe('concurrent-skill');
      expect(installed.id).toBe('concurrent-cache');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('replaces a corrupt cached archive and uses a new archive when the hash changes', async () => {
    const fixture = await makeZip('recovery-cache');
    const nextFixture = await makeZip('recovery-cache', '2.0.0', 'next-skill');
    try {
      const sha256sum = createHash('sha256').update(fixture.buffer).digest('hex');
      const source = 'https://example.test/recovery-cache.zip';
      const fetchImpl = vi.fn(async () => new Response(fixture.buffer)) as unknown as typeof fetch;
      const options = { expectedSha256: sha256sum, expectedPluginId: 'recovery-cache', fetchImpl };
      const archivePath = join(home, 'plugins', 'cache', 'archives', `${sha256sum}.zip`);
      await new PluginManager({ kimiHomeDir: home }).inspect(source, options);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await writeFile(archivePath, 'corrupt archive');
      await new PluginManager({ kimiHomeDir: home }).inspect(source, options);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await expect(readFile(archivePath)).resolves.toEqual(fixture.buffer);

      const nextSha256 = createHash('sha256').update(nextFixture.buffer).digest('hex');
      const nextFetch = vi.fn(async () => new Response(nextFixture.buffer)) as unknown as typeof fetch;
      const next = await new PluginManager({ kimiHomeDir: home }).inspect(source, {
        expectedSha256: nextSha256,
        expectedPluginId: 'recovery-cache',
        fetchImpl: nextFetch,
      });

      expect(next.skills[0]?.name).toBe('next-skill');
      expect(nextFetch).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(nextFixture.dir, { recursive: true, force: true });
    }
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

  it('rejects a SHA mismatch before trying to extract the archive', async () => {
    const manager = new PluginManager({ kimiHomeDir: home });
    const fetchImpl = vi.fn(async () => new Response('not a zip')) as unknown as typeof fetch;

    await expect(
      manager.install('https://example.test/plugin.zip', {
        expectedSha256: '0'.repeat(64),
        expectedPluginId: 'demo',
        origin: 'marketplace',
        catalogId: 'demo',
        fetchImpl,
      }),
    ).rejects.toThrow('SHA-256 mismatch');
    expect(manager.get('demo')).toBeUndefined();
  });

  it('rejects a manifest ID mismatch before publishing the managed copy', async () => {
    const fixture = await makeZip('actual-id');
    try {
      const manager = new PluginManager({ kimiHomeDir: home });
      const sha256sum = createHash('sha256').update(fixture.buffer).digest('hex');
      const fetchImpl = vi.fn(async () => new Response(fixture.buffer)) as unknown as typeof fetch;

      await expect(
        manager.install('https://example.test/plugin.zip', {
          expectedSha256: sha256sum,
          expectedPluginId: 'expected-id',
          origin: 'marketplace',
          catalogId: 'expected-id',
          fetchImpl,
        }),
      ).rejects.toThrow('Plugin manifest ID mismatch');
      expect(manager.get('actual-id')).toBeUndefined();
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('converts marketplace and custom reinstalls while preserving installedAt', async () => {
    const fixture = await makeZip('demo', '2.0.0');
    const customSource = await mkdtemp(join(tmpdir(), 'plugin-custom-reinstall-'));
    try {
      await writeFile(
        join(customSource, 'kimi.plugin.json'),
        JSON.stringify({ name: 'demo', version: '3.0.0' }),
        'utf8',
      );
      const manager = new PluginManager({ kimiHomeDir: home });
      const sha256sum = createHash('sha256').update(fixture.buffer).digest('hex');
      const fetchImpl = vi.fn(async () => new Response(fixture.buffer)) as unknown as typeof fetch;
      const source = 'https://example.test/plugin.zip';
      const installMarketplace = () =>
        manager.install(source, {
          expectedSha256: sha256sum,
          expectedPluginId: 'demo',
          origin: 'marketplace',
          catalogId: 'demo',
          fetchImpl,
        });

      const marketplace = await installMarketplace();
      const custom = await manager.install(customSource);
      expect(custom).toMatchObject({
        origin: 'custom',
        catalogId: undefined,
        installedAt: marketplace.installedAt,
        manifest: { version: '3.0.0' },
      });

      const reinstalled = await installMarketplace();
      expect(reinstalled).toMatchObject({
        origin: 'marketplace',
        catalogId: 'demo',
        installedAt: marketplace.installedAt,
        manifest: { version: '2.0.0' },
      });
      await manager.reload();
      expect(manager.summaries()[0]).toMatchObject({
        origin: 'marketplace',
        catalogId: 'demo',
        installedAt: marketplace.installedAt,
      });
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
      await rm(customSource, { recursive: true, force: true });
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

  it('migrates a plugin atomically while preserving legacy state', async () => {
    const legacyRoot = await mkdtemp(join(tmpdir(), 'plugin-legacy-'));
    const fixture = await makeZip('new-plugin', '2.0.0');
    try {
      await writeFile(
        join(legacyRoot, 'kimi.plugin.json'),
        JSON.stringify({ name: 'legacy', version: '1.0.0' }),
        'utf8',
      );
      await writeFile(
        join(home, 'plugins', 'installed.json'),
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: 'legacy',
              root: legacyRoot,
              source: 'zip-url',
              origin: 'marketplace',
              catalogId: 'legacy',
              enabled: false,
              installedAt: '2020-01-01T00:00:00.000Z',
              capabilities: { mcpServers: { mac: { enabled: false } } },
            },
          ],
        }),
        'utf8',
      );
      const manager = new PluginManager({ kimiHomeDir: home });
      await manager.load();
      const sha256sum = createHash('sha256').update(fixture.buffer).digest('hex');
      const fetchImpl = vi.fn(async () => new Response(fixture.buffer)) as unknown as typeof fetch;

      const record = await manager.install('https://example.test/new-plugin.zip', {
        expectedSha256: sha256sum,
        expectedPluginId: 'new-plugin',
        origin: 'marketplace',
        catalogId: 'new-plugin',
        migrateFrom: 'legacy',
        fetchImpl,
      });

      expect(record).toMatchObject({
        id: 'new-plugin',
        enabled: false,
        installedAt: '2020-01-01T00:00:00.000Z',
        origin: 'marketplace',
        catalogId: 'new-plugin',
        capabilities: { mcpServers: { mac: { enabled: false } } },
      });
      expect(manager.get('legacy')).toBeUndefined();
      const stored = JSON.parse(
        await readFile(join(home, 'plugins', 'installed.json'), 'utf8'),
      ) as { plugins: Array<{ id: string }> };
      expect(stored.plugins.map((plugin) => plugin.id)).toEqual(['new-plugin']);
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('keeps the legacy plugin when migration validation fails', async () => {
    const legacyRoot = await mkdtemp(join(tmpdir(), 'plugin-legacy-'));
    const fixture = await makeZip('new-plugin', '2.0.0');
    try {
      await writeFile(
        join(legacyRoot, 'kimi.plugin.json'),
        JSON.stringify({ name: 'legacy', version: '1.0.0' }),
        'utf8',
      );
      await writeFile(
        join(home, 'plugins', 'installed.json'),
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: 'legacy',
              root: legacyRoot,
              source: 'zip-url',
              origin: 'marketplace',
              catalogId: 'legacy',
              enabled: false,
              installedAt: '2020-01-01T00:00:00.000Z',
            },
          ],
        }),
        'utf8',
      );
      const manager = new PluginManager({ kimiHomeDir: home });
      await manager.load();
      const fetchImpl = vi.fn(async () => new Response(fixture.buffer)) as unknown as typeof fetch;

      await expect(
        manager.install('https://example.test/new-plugin.zip', {
          expectedSha256: '0'.repeat(64),
          expectedPluginId: 'new-plugin',
          origin: 'marketplace',
          catalogId: 'new-plugin',
          migrateFrom: 'legacy',
          fetchImpl,
        }),
      ).rejects.toThrow('SHA-256 mismatch');
      expect(manager.get('new-plugin')).toBeUndefined();
      expect(manager.get('legacy')).toMatchObject({
        enabled: false,
        installedAt: '2020-01-01T00:00:00.000Z',
      });
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('materializes the canonical WebBridge plugin and target skill before committing migration', async () => {
    const legacyRoot = await makeLegacyWebbridge();
    const fixture = await makeZip('kimi-browser-extension', '2.0.0', 'kimi-webbridge');
    try {
      const manager = new PluginManager({ kimiHomeDir: home });
      await manager.load();

      const { record, summary } = await installWebbridge(manager, fixture);

      expect(record).toMatchObject({
        id: 'kimi-browser-extension',
        enabled: false,
        installedAt: '2020-01-01T00:00:00.000Z',
        state: 'ok',
        skillCount: 1,
        capabilities: { mcpServers: { mac: { enabled: false } } },
      });
      expect(summary).toEqual({ added: [], removed: [], errors: [] });
      expect(manager.get('kimi-webbridge')).toBeUndefined();
      const stored = JSON.parse(
        await readFile(join(home, 'plugins', 'installed.json'), 'utf8'),
      ) as { plugins: Array<{ id: string }> };
      expect(stored.plugins.map((plugin) => plugin.id)).toEqual(['kimi-browser-extension']);
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'missing', skillName: undefined },
    { label: 'wrong', skillName: 'other-skill' },
  ])('keeps the legacy WebBridge record when the new package has a $label target skill', async ({ skillName }) => {
    const legacyRoot = await makeLegacyWebbridge();
    const fixture = await makeZip('kimi-browser-extension', '2.0.0', skillName);
    try {
      const manager = new PluginManager({ kimiHomeDir: home });
      await manager.load();
      const before = await readFile(join(home, 'plugins', 'installed.json'), 'utf8');

      await expect(installWebbridge(manager, fixture)).rejects.toThrow(
        'does not provide required skill "kimi-webbridge"',
      );

      expect(manager.get('kimi-browser-extension')).toBeUndefined();
      expect(manager.get('kimi-webbridge')).toMatchObject({
        enabled: false,
        installedAt: '2020-01-01T00:00:00.000Z',
        capabilities: { mcpServers: { mac: { enabled: false } } },
      });
      await expect(readFile(join(home, 'plugins', 'installed.json'), 'utf8')).resolves.toBe(before);
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('restores the legacy record and managed copy when WebBridge reload materialization fails', async () => {
    const legacyRoot = await makeLegacyWebbridge();
    const fixture = await makeZip('kimi-browser-extension', '2.0.0', 'kimi-webbridge');
    try {
      let discoveries = 0;
      const manager = new PluginManager({
        kimiHomeDir: home,
        discoverSkills: async (roots) => {
          discoveries += 1;
          if (discoveries === 2) throw new Error('reload materialize failed');
          return discoverFileSkills(roots);
        },
      });
      await manager.load();
      const before = await readFile(join(home, 'plugins', 'installed.json'), 'utf8');

      await expect(installWebbridge(manager, fixture)).rejects.toThrow(
        /failed to reload after installation.*reload materialize failed/,
      );

      expect(manager.get('kimi-browser-extension')).toBeUndefined();
      expect(manager.get('kimi-webbridge')).toMatchObject({
        enabled: false,
        installedAt: '2020-01-01T00:00:00.000Z',
      });
      const restored = await readFile(join(home, 'plugins', 'installed.json'), 'utf8');
      expect(JSON.parse(restored)).toEqual(JSON.parse(before));
      await expect(
        readFile(
          join(home, 'plugins', 'managed', 'kimi-browser-extension', 'kimi.plugin.json'),
          'utf8',
        ),
      ).rejects.toThrow();
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('rejects migration when the target skill is absent from the reloaded canonical plugin', async () => {
    const legacyRoot = await makeLegacyWebbridge();
    const fixture = await makeZip('kimi-browser-extension', '2.0.0', 'kimi-webbridge');
    try {
      let discoveries = 0;
      const manager = new PluginManager({
        kimiHomeDir: home,
        discoverSkills: async (roots) => {
          discoveries += 1;
          if (discoveries === 2) {
            return { skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] };
          }
          return discoverFileSkills(roots);
        },
      });
      await manager.load();

      await expect(installWebbridge(manager, fixture)).rejects.toThrow(
        /failed to reload after installation.*does not provide required skill "kimi-webbridge"/,
      );

      expect(manager.get('kimi-browser-extension')).toBeUndefined();
      expect(manager.get('kimi-webbridge')).toMatchObject({
        enabled: false,
        installedAt: '2020-01-01T00:00:00.000Z',
      });
      const stored = JSON.parse(
        await readFile(join(home, 'plugins', 'installed.json'), 'utf8'),
      ) as { plugins: Array<{ id: string }> };
      expect(stored.plugins.map((plugin) => plugin.id)).toEqual(['kimi-webbridge']);
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it('reports compensation failure while restoring the in-memory legacy WebBridge record', async () => {
    const legacyRoot = await makeLegacyWebbridge();
    const fixture = await makeZip('kimi-browser-extension', '2.0.0', 'kimi-webbridge');
    try {
      let discoveries = 0;
      const manager = new PluginManager({
        kimiHomeDir: home,
        discoverSkills: async (roots) => {
          discoveries += 1;
          if (discoveries === 2) {
            await mkdir(join(home, 'plugins', 'installed.json.tmp'));
            throw new Error('reload materialize failed');
          }
          return discoverFileSkills(roots);
        },
      });
      await manager.load();

      const failure = await installWebbridge(manager, fixture).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        'previous plugin state could not be fully restored',
      );
      expect((failure as Error).cause).toBeInstanceOf(AggregateError);
      expect(manager.get('kimi-browser-extension')).toBeUndefined();
      expect(manager.get('kimi-webbridge')).toMatchObject({
        enabled: false,
        installedAt: '2020-01-01T00:00:00.000Z',
      });
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
      await rm(fixture.dir, { recursive: true, force: true });
    }
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
