import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';

import {
  createFeature,
  type ProviderCatalogFace,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  ProviderCatalogRef,
  Trees,
  useAgent,
  useAgentTools,
  type AgentHandle,
  type AppHandle,
  type CatalogProviderInfo,
  type FeatureSpec,
  type AgentLlmRequester,
  type Message,
  type SessionStores,
  type ToolDescription,
} from '@moonshot-ai/agent-core';
import { useExpose } from '@moonshot-ai/agent-core/kernel/index';
import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';

import { createMcp, McpRef } from '#/features/mcp/index';
import { createNodeOsHost, type OsHost } from '#/features/os/host/index';
import { resolveInstallSource } from '#/features/plugin/acquire/source';
import {
  computeUpdateStatus,
  createPlugin,
  KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV,
  parsePluginMarketplace,
  PluginError,
  PluginRef,
  readPluginMarketplace,
  resolveMarketplaceLocation,
  withBuiltInEntries,
  withLatestVersions,
  type MarketplaceLocation,
  type PluginFace,
  type PluginMutationSummary,
  type ReloadSummary,
} from '#/features/plugin/index';
import {
  expandCommandArguments,
  parseCommandText,
} from '#/features/plugin/inspect/commands';
import {
  parseManifest,
  PLUGIN_SYSTEM_PROMPT_MAX_BYTES,
} from '#/features/plugin/manifest/manifest';
import { readInstalled, writeInstalled } from '#/features/plugin/state/store';
import { createProfiles, ProfileCatalogRef } from '#/features/profiles/index';
import { createSkill, SkillCatalogRef } from '#/features/skill/index';

import { fakeRequester, textOutcome, testModel } from '../fake-llm';

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall) => { text: string } | { toolCall: { name: string; arguments: string } };

function createMockRequester(script: LlmScript): { requester: AgentLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: fakeRequester((rest, onEvent) => {
        const call: LlmCall = {
          systemPrompt: rest.profile?.systemPrompt,
          messages: rest.content?.messages ?? [],
          tools: rest.profile?.tools ?? [],
        };
        calls.push(call);
        const out = script(call);
        onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        });
        if ('toolCall' in out) {
          return textOutcome('', [
            { type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments },
          ]);
        }
        return textOutcome(out.text);
      }),
  };
}

const toolTurnScript: LlmScript = (call) => {
  const last = call.messages.at(-1);
  if (last !== undefined && last.role === 'tool') return { text: 'done' };
  const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
  if (text === 'run') return { toolCall: { name: 'Read', arguments: '{}' } };
  return { text: `echo:${text}` };
};

function bindTestLlm(requester: AgentLlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(testModel);
      agent.setRequester(requester);
    },
  });
}

function bindTestTools(): FeatureSpec {
  return createFeature('test-tools', {
    agent() {
      useAgentTools({
        name: 'Read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text' as const, text: 'file contents' }] }),
      });
    },
  });
}

let host: OsHost;
let home: string;
let workDir: string;
let brandHome: string;

const tempDirs: string[] = [];

beforeEach(async () => {
  host = createNodeOsHost();
  home = await realpath(await mkdtemp(join(tmpdir(), 'plugin-home-')));
  workDir = await realpath(await mkdtemp(join(tmpdir(), 'plugin-work-')));
  brandHome = await realpath(await mkdtemp(join(tmpdir(), 'plugin-brand-')));
  tempDirs.push(home, workDir, brandHome);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await condition()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface MakePluginOptions {
  readonly skills?: readonly string[];
  readonly skillContents?: Readonly<Record<string, string>>;
  readonly skillInstructions?: string;
  readonly agents?: readonly string[];
  readonly sessionStartSkill?: string;
  readonly systemPrompt?: string;
  readonly mcpServers?: Readonly<Record<string, unknown>>;
  readonly hooks?: readonly unknown[];
  readonly commands?: Readonly<Record<string, string>>;
  readonly version?: string;
}

async function makePlugin(name: string, options: MakePluginOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `plugin-${name}-`));
  tempDirs.push(root);
  const manifest: Record<string, unknown> = { name };
  if (options.version !== undefined) manifest['version'] = options.version;
  if (options.skillInstructions !== undefined) {
    manifest['skillInstructions'] = options.skillInstructions;
  }
  const skillNames = options.skills ?? [];
  if (skillNames.length > 0) {
    manifest['skills'] = './skills/';
    for (const skillName of skillNames) {
      await mkdir(join(root, 'skills', skillName), { recursive: true });
      await writeFile(
        join(root, 'skills', skillName, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: A demo\n---\n${options.skillContents?.[skillName] ?? 'body'}`,
        'utf8',
      );
    }
  }
  if (options.agents !== undefined && options.agents.length > 0) {
    manifest['agents'] = './agents/';
    await mkdir(join(root, 'agents'), { recursive: true });
    for (const agentName of options.agents) {
      await writeFile(
        join(root, 'agents', `${agentName}.md`),
        `---\nname: ${agentName}\ndescription: A demo agent\n---\nbody`,
        'utf8',
      );
    }
  }
  if (options.sessionStartSkill !== undefined) {
    manifest['sessionStart'] = { skill: options.sessionStartSkill };
  }
  if (options.systemPrompt !== undefined) manifest['systemPrompt'] = options.systemPrompt;
  if (options.mcpServers !== undefined) manifest['mcpServers'] = options.mcpServers;
  if (options.hooks !== undefined) manifest['hooks'] = options.hooks;
  if (options.commands !== undefined) {
    manifest['commands'] = ['./commands'];
    for (const [file, body] of Object.entries(options.commands)) {
      const filePath = join(root, 'commands', file);
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, body, 'utf8');
    }
  }
  await writeFile(join(root, 'kimi.plugin.json'), JSON.stringify(manifest), 'utf8');
  return realpath(root);
}

function zipBuffers(entries: ReadonlyArray<{ readonly name: string; readonly content: string }>): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolvePromise(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    for (const entry of entries) zip.addBuffer(Buffer.from(entry.content, 'utf8'), entry.name);
    zip.end();
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(handler(url, init));
    }) as unknown as typeof fetch,
  );
}

async function startPluginApp(extraFeatures: readonly FeatureSpec[] = []): Promise<{
  app: AppHandle;
  pluginFeature: FeatureSpec;
  face: PluginFace;
}> {
  const pluginFeature = createPlugin({ homeDir: home, host });
  const app = createHarness({ features: [pluginFeature, ...extraFeatures] });
  await app.ready();
  return { app, pluginFeature, face: app.resolve(PluginRef) };
}

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

async function startAgentApp(): Promise<{
  app: AppHandle;
  session: Awaited<ReturnType<AppHandle['create']>>;
  stores: SessionStores;
  face: PluginFace;
  calls: readonly LlmCall[];
  main: () => AgentHandle;
  recreateMain: () => Promise<void>;
  runTurn: (text: string) => Promise<void>;
  dispose: () => Promise<void>;
}> {
  const env = await testStores();
  const { requester, calls } = createMockRequester(toolTurnScript);
  const pluginFeature = createPlugin({ homeDir: home, host });
  const app = createHarness({
    features: [
      createSkill({ workDir, fs: host.fs, home: brandHome }),
      pluginFeature,
      bindTestTools(),
      bindTestLlm(requester),
    ],
  });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores: env.stores });
  let main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  await main.ready();
  const runTurn = async (text: string): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      main.on('turn.done', () => {
        resolve();
      });
    });
    main.submit(createUserMessage(text));
    await done;
    await env.stores.flush();
  };
  return {
    app,
    session,
    stores: env.stores,
    face: app.resolve(PluginRef),
    calls,
    main: () => main,
    recreateMain: async () => {
      await session.close(MAIN_AGENT_ID);
      main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
      await main.ready();
    },
    runTurn,
    dispose: async () => {
      await app.disposeAsync();
      await env.stores.dispose();
    },
  };
}

function reminderTexts(stores: SessionStores, key: string): string[] {
  return (stores.get(MAIN_AGENT_ID)?.getState().history ?? [])
    .filter((entry) => entry.meta?.source === 'reminder' && entry.meta?.key === key)
    .map((entry) => extractText(entry.message));
}

describe('resolveInstallSource', () => {
  it('resolves local paths, zip urls, and github url forms', () => {
    expect(resolveInstallSource('/tmp/plugin')).toEqual({ kind: 'local-path', path: '/tmp/plugin' });
    expect(resolveInstallSource('https://example.com/plugin.zip')).toEqual({
      kind: 'zip-url',
      path: 'https://example.com/plugin.zip',
    });
    expect(resolveInstallSource('https://github.com/owner/repo/tree/release%231')).toEqual({
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
      ref: { kind: 'branch', value: 'release#1' },
    });
    expect(resolveInstallSource('https://github.com/owner/repo/releases/tag/v1.2.3')).toEqual({
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
      ref: { kind: 'tag', value: 'v1.2.3' },
    });
    expect(resolveInstallSource('https://github.com/owner/repo/commit/abc1234')).toEqual({
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
      ref: { kind: 'sha', value: 'abc1234' },
    });
    expect(resolveInstallSource('https://github.com/owner/repo')).toEqual({
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('rejects relative paths with validation.failed', () => {
    const failure = (() => {
      try {
        resolveInstallSource('./plugin');
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(PluginError);
    expect((failure as PluginError).code).toBe('validation.failed');
    expect((failure as PluginError).message).toBe(
      'Plugin root must be an absolute path (got "./plugin")',
    );
  });
});

describe('plugin command parsing', () => {
  it('parses frontmatter, falls back to file name and first body line, and expands $ARGUMENTS', () => {
    const parsed = parseCommandText({
      text: '---\nname: deploy\ndescription: Deploy the app\n---\n\nRun deploy.',
      commandPath: join(workDir, 'deploy.md'),
      pluginId: 'demo',
    });
    expect(parsed).toEqual({
      pluginId: 'demo',
      name: 'deploy',
      description: 'Deploy the app',
      body: 'Run deploy.',
      path: join(workDir, 'deploy.md'),
    });

    const fallback = parseCommandText({
      text: 'Build the component\n\nMore detail.',
      commandPath: join(workDir, 'frontend', 'component.md'),
      pluginId: 'demo',
      fallbackName: 'frontend/component',
    });
    expect(fallback.name).toBe('frontend/component');
    expect(fallback.description).toBe('Build the component');
    expect(fallback.body).toBe('Build the component\n\nMore detail.');

    expect(expandCommandArguments('deploy $ARGUMENTS now', 'prod')).toBe('deploy prod now');
    expect(expandCommandArguments('deploy now', 'prod')).toBe('deploy now\n\nARGUMENTS: prod');
    expect(expandCommandArguments('deploy now', '')).toBe('deploy now');
  });
});

describe('parseManifest', () => {
  it('reads both manifest forms, detects shadowing, and reports unsupported and invalid fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-manifest-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.kimi-plugin'), { recursive: true });
    await writeFile(
      join(dir, '.kimi-plugin', 'plugin.json'),
      JSON.stringify({ name: 'dir-form' }),
      'utf8',
    );

    const dirOnly = await parseManifest(host.fs, dir);
    expect(dirOnly.manifestKind).toBe('kimi-plugin-dir');
    expect(dirOnly.manifest?.name).toBe('dir-form');
    expect(dirOnly.shadowedManifestPath).toBeUndefined();

    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'root-form',
        tools: ['x'],
        bootstrap: 'y',
        commands: ['../outside.md'],
        hooks: [{ event: 'Nope', command: 'echo nope' }],
      }),
      'utf8',
    );

    const both = await parseManifest(host.fs, dir);
    expect(both.manifestKind).toBe('kimi-plugin-root');
    expect(both.manifest?.name).toBe('root-form');
    expect(both.shadowedManifestPath).toBe(join(dir, '.kimi-plugin', 'plugin.json'));
    expect(both.manifest?.commands).toBeUndefined();
    expect(both.manifest?.hooks).toBeUndefined();
    expect(both.diagnostics.map((d) => [d.severity, d.message])).toEqual([
      ['info', '"tools" is present but not supported by Kimi plugins'],
      ['info', '"bootstrap" is present but not supported by Kimi plugins'],
      ['warn', expect.stringContaining('Invalid hook at index 0')],
      ['warn', '"commands" path must start with "./" (got "../outside.md")'],
    ]);
  });

  it('enforces the 32 KB systemPrompt limit and strips BOM from systemPromptPath files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-prompt-'));
    tempDirs.push(dir);
    const oversized = 'x'.repeat(PLUGIN_SYSTEM_PROMPT_MAX_BYTES + 1);
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', systemPrompt: oversized }),
      'utf8',
    );

    const tooBig = await parseManifest(host.fs, dir);
    expect(tooBig.manifest?.systemPrompt).toBeUndefined();
    expect(tooBig.diagnostics.map((d) => d.message)).toEqual([
      `"systemPrompt" is ${PLUGIN_SYSTEM_PROMPT_MAX_BYTES + 1} bytes, exceeding the 32 KB limit; the field is ignored`,
    ]);

    await writeFile(join(dir, 'PROMPT.md'), 'x'.repeat(PLUGIN_SYSTEM_PROMPT_MAX_BYTES), 'utf8');
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({ name: 'demo', systemPromptPath: './PROMPT.md' }),
      'utf8',
    );

    const atLimit = await parseManifest(host.fs, dir);
    expect(atLimit.manifest?.systemPrompt).toBe('x'.repeat(PLUGIN_SYSTEM_PROMPT_MAX_BYTES));
    expect(atLimit.diagnostics).toEqual([]);

    await writeFile(join(dir, 'PROMPT.md'), '﻿Always cite sources.\n', 'utf8');

    const withBom = await parseManifest(host.fs, dir);
    expect(withBom.manifest?.systemPrompt).toBe('Always cite sources.');
    expect(withBom.diagnostics).toEqual([]);
  });
});

describe('plugin store', () => {
  it('round-trips installed.json and rejects corrupt JSON with plugin.load_failed', async () => {
    const data = {
      version: 1 as const,
      plugins: [
        {
          id: 'demo',
          root: '/plugins/demo',
          source: 'local-path' as const,
          enabled: true,
          installedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    await writeInstalled(host.fs, home, data);
    expect(await readInstalled(host.fs, home)).toEqual(data);
    expect(JSON.parse(await readFile(join(home, 'plugins', 'installed.json'), 'utf8'))).toEqual(
      JSON.parse(JSON.stringify(data)),
    );

    await writeFile(join(home, 'plugins', 'installed.json'), '{ not json', 'utf8');
    const failure = await readInstalled(host.fs, home).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PluginError);
    expect((failure as PluginError).code).toBe('plugin.load_failed');
    expect((failure as PluginError).message).toContain('Failed to parse');
  });
});

describe('plugin install', () => {
  it('installs a local-path plugin into the managed root with records, summary, and diagnostics', async () => {
    const { app, face } = await startPluginApp();
    try {
      const sourceRoot = await makePlugin('other', { version: '1.0.0' });
      const summary = await face.installPlugin(sourceRoot);

      const managedRoot = await realpath(join(home, 'plugins', 'managed', 'other'));
      expect(summary).toEqual(
        expect.objectContaining({
          id: 'other',
          displayName: 'other',
          version: '1.0.0',
          enabled: true,
          state: 'ok',
          hasErrors: false,
          source: 'local-path',
        }),
      );
      const info = await face.getPluginInfo('other');
      expect(info.root).toBe(managedRoot);
      expect(info.manifest?.name).toBe('other');
      expect(info.manifestKind).toBe('kimi-plugin-root');
      expect(info.diagnostics).toEqual([]);
      await expect(readFile(join(managedRoot, 'kimi.plugin.json'), 'utf8')).resolves.toContain(
        '"version":"1.0.0"',
      );

      const stored = JSON.parse(await readFile(join(home, 'plugins', 'installed.json'), 'utf8')) as {
        plugins: Array<{ id: string; root: string; source: string }>;
      };
      expect(stored.plugins).toEqual([
        expect.objectContaining({ id: 'other', root: managedRoot, source: 'local-path' }),
      ]);

      const noManifest = await mkdtemp(join(tmpdir(), 'plugin-empty-'));
      tempDirs.push(noManifest);
      const failure = await face.installPlugin(noManifest).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PluginError);
      expect((failure as PluginError).code).toBe('plugin.load_failed');
      expect((failure as PluginError).message).toBe(
        `Cannot install plugin at ${await realpath(noManifest)}: No manifest at kimi.plugin.json or .kimi-plugin/plugin.json`,
      );
    } finally {
      await app.disposeAsync();
    }
  });

  it('installs a zip-url plugin, detects a nested plugin root, and cleans the staging dir', async () => {
    const { app, face } = await startPluginApp();
    try {
      const zip = await zipBuffers([
        { name: 'pkg/kimi.plugin.json', content: JSON.stringify({ name: 'zip-plugin' }) },
        { name: 'pkg/README.md', content: 'readme' },
      ]);
      mockFetch(() => new Response(new Uint8Array(zip), { status: 200 }));

      const summary = await face.installPlugin('https://downloads.example.test/plugin.zip');

      expect(summary).toEqual(
        expect.objectContaining({ id: 'zip-plugin', source: 'zip-url', state: 'ok' }),
      );
      const info = await face.getPluginInfo('zip-plugin');
      expect(info.manifest?.name).toBe('zip-plugin');
      await expect(
        readFile(join(info.root, 'README.md'), 'utf8'),
      ).resolves.toBe('readme');
      const pluginDirEntries = await readdir(join(home, 'plugins'));
      expect(pluginDirEntries.filter((entry) => entry.startsWith('.zip-staging'))).toEqual([]);
    } finally {
      await app.disposeAsync();
    }
  });

  it('rejects a zip whose entries escape the extraction directory', async () => {
    const { app, face } = await startPluginApp();
    try {
      const zip = await zipBuffers([
        { name: 'aa/evil.txt', content: 'evil' },
        { name: 'kimi.plugin.json', content: JSON.stringify({ name: 'evil' }) },
      ]);
      const patched = Buffer.from(zip);
      let index = patched.indexOf('aa/evil.txt');
      while (index !== -1) {
        patched.write('../evil.txt', index, 'utf8');
        index = patched.indexOf('aa/evil.txt', index + 1);
      }
      mockFetch(() => new Response(new Uint8Array(patched), { status: 200 }));

      await expect(face.installPlugin('https://downloads.example.test/evil.zip')).rejects.toThrow(
        'invalid relative path: ../evil.txt',
      );
      const pluginDirEntries = await readdir(join(home, 'plugins'));
      expect(pluginDirEntries.filter((entry) => entry.startsWith('.zip-staging'))).toEqual([]);
    } finally {
      await app.disposeAsync();
    }
  });

  it('installs a github plugin through codeload with the resolved commit pinned', async () => {
    const { app, face } = await startPluginApp();
    try {
      const commitSha = '1111111111111111111111111111111111111111';
      const zip = await zipBuffers([
        { name: 'kimi.plugin.json', content: JSON.stringify({ name: 'github-plugin' }) },
      ]);
      mockFetch((url) => {
        if (url.endsWith('/commits/v1.atom')) {
          return new Response(
            `<entry><id>tag:github.com,2008:Grit::Commit/${commitSha}</id></entry>`,
          );
        }
        if (url.startsWith('https://codeload.github.com/')) {
          return new Response(new Uint8Array(zip), { status: 200 });
        }
        throw new Error(`unexpected url ${url}`);
      });

      const summary = await face.installPlugin('https://github.com/owner/repo/tree/v1');

      expect(summary).toEqual(expect.objectContaining({ id: 'github-plugin', source: 'github' }));
      expect(fetch).toHaveBeenCalledWith(
        `https://codeload.github.com/owner/repo/zip/${commitSha}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const info = await face.getPluginInfo('github-plugin');
      expect(info.github).toEqual({
        owner: 'owner',
        repo: 'repo',
        ref: { kind: 'branch', value: 'v1' },
        installedSha: commitSha,
      });
      const stored = JSON.parse(await readFile(join(home, 'plugins', 'installed.json'), 'utf8')) as {
        plugins: Array<{ id: string; github?: { installedSha?: string } }>;
      };
      expect(stored.plugins[0]?.github?.installedSha).toBe(commitSha);
    } finally {
      await app.disposeAsync();
    }
  });
});

describe('checkUpdates', () => {
  async function seedGithubRecord(record: Record<string, unknown>): Promise<void> {
    const pluginRoot = await makePlugin('demo', {});
    await mkdir(join(home, 'plugins'), { recursive: true });
    await writeFile(
      join(home, 'plugins', 'installed.json'),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'demo',
            root: pluginRoot,
            source: 'github',
            enabled: true,
            installedAt: '2026-01-01T00:00:00.000Z',
            ...record,
          },
        ],
      }),
      'utf8',
    );
  }

  it('reports no update for pinned refs without network and detects branch advances', async () => {
    const sha = '1111111111111111111111111111111111111111';
    await seedGithubRecord({
      github: { owner: 'owner', repo: 'repo', ref: { kind: 'tag', value: 'v1.0.0' } },
      originalSource: 'https://github.com/owner/repo/releases/tag/v1.0.0',
    });
    const { app, face } = await startPluginApp();
    try {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(face.checkUpdates()).resolves.toEqual([
        {
          id: 'demo',
          source: 'github',
          current: { kind: 'tag', value: 'v1.0.0' },
          latest: { kind: 'tag', value: 'v1.0.0' },
          displayVersion: 'v1.0.0',
          updateAvailable: false,
        },
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.disposeAsync();
    }

    await seedGithubRecord({
      originalSource: 'https://github.com/owner/repo/tree/main',
      github: {
        owner: 'owner',
        repo: 'repo',
        ref: { kind: 'branch', value: 'main' },
        installedSha: sha,
      },
    });
    const second = await startPluginApp();
    try {
      mockFetch((url) => {
        if (url.endsWith('/commits/main.atom')) {
          return new Response(
            `<entry><id>tag:github.com,2008:Grit::Commit/${'2222222222222222222222222222222222222222'}</id></entry>`,
          );
        }
        throw new Error(`unexpected url ${url}`);
      });
      await expect(second.face.checkUpdates()).resolves.toEqual([
        expect.objectContaining({
          id: 'demo',
          current: { kind: 'branch', value: 'main' },
          latest: { kind: 'branch', value: 'main' },
          updateAvailable: true,
        }),
      ]);
    } finally {
      await second.app.disposeAsync();
    }
  });
});

describe('plugin mutations and consumption plane', () => {
  it('fires plugin.mutated for install/enable/disable/remove but not for explicit reload, and reports reload summaries', async () => {
    const { app, pluginFeature, face } = await startPluginApp();
    try {
      const mutations: PluginMutationSummary[] = [];
      const reloads: ReloadSummary[] = [];
      app.on(pluginFeature, 'plugin.mutated', (event) => mutations.push(event.summary));
      app.on(pluginFeature, 'plugin.changed', (event) =>
        reloads.push({
          added: event.summary.added,
          removed: event.summary.removed,
          errors: event.summary.errors,
        }),
      );
      const pluginRoot = await makePlugin('mutate-demo', { version: '1.0.0' });

      await face.installPlugin(pluginRoot);
      await face.setPluginEnabled('mutate-demo', false);
      await face.setPluginEnabled('mutate-demo', true);
      await face.removePlugin('mutate-demo');

      expect(mutations.map((summary) => summary.mutation)).toEqual([
        { kind: 'install', id: 'mutate-demo' },
        { kind: 'disable', id: 'mutate-demo' },
        { kind: 'enable', id: 'mutate-demo' },
        { kind: 'remove', id: 'mutate-demo' },
      ]);
      expect(mutations[0]).toEqual(
        expect.objectContaining({ added: [], removed: [], errors: [] }),
      );
      expect(mutations[3]).toEqual(
        expect.objectContaining({ added: [], removed: [], errors: [] }),
      );
      expect(reloads).toHaveLength(4);
      await expect(face.listPlugins()).resolves.toEqual([]);

      await face.reloadPlugins();
      expect(mutations).toHaveLength(4);
      expect(reloads).toHaveLength(5);

      const failure = await face
        .setPluginEnabled('mutate-demo', false)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PluginError);
      expect((failure as PluginError).code).toBe('plugin.not_found');
      expect((failure as PluginError).message).toBe('Plugin "mutate-demo" is not installed');
    } finally {
      await app.disposeAsync();
    }
  });

  it('projects skill roots, agent roots, session starts, system prompts, hooks, mcp servers, and commands', async () => {
    const { app, face } = await startPluginApp();
    try {
      const pluginRoot = await makePlugin('demo', {
        skills: ['demo-skill'],
        agents: ['demo-agent'],
        sessionStartSkill: 'demo-skill',
        systemPrompt: 'Always cite sources.',
        mcpServers: {
          finance: { command: 'finance-mcp', env: { CUSTOM: '1' } },
          docs: { url: 'https://example.com/mcp' },
        },
        hooks: [{ event: 'PreToolUse', command: './hooks/guard.sh', timeout: 10 }],
        commands: { 'deploy.md': '---\ndescription: Deploy\n---\n\nBody' },
      });
      await face.installPlugin(pluginRoot);
      const managedRoot = await realpath(join(home, 'plugins', 'managed', 'demo'));

      await expect(face.pluginSkillRoots()).resolves.toEqual([
        {
          path: join(managedRoot, 'skills'),
          source: 'extra',
          plugin: { id: 'demo', instructions: undefined },
          scanMode: undefined,
        },
      ]);
      await expect(face.pluginAgentRoots()).resolves.toEqual([
        { path: join(managedRoot, 'agents'), source: 'plugin' },
      ]);
      await expect(face.enabledSessionStarts()).resolves.toEqual([
        { pluginId: 'demo', skillName: 'demo-skill' },
      ]);
      await expect(face.enabledSystemPrompts()).resolves.toEqual([
        { pluginId: 'demo', content: 'Always cite sources.' },
      ]);
      await expect(face.enabledHooks()).resolves.toEqual([
        {
          event: 'PreToolUse',
          command: './hooks/guard.sh',
          timeout: 10,
          cwd: managedRoot,
          env: { KIMI_CODE_HOME: home, KIMI_PLUGIN_ROOT: managedRoot },
        },
      ]);
      await expect(face.listPluginCommands()).resolves.toEqual([
        expect.objectContaining({
          pluginId: 'demo',
          name: 'deploy',
          description: 'Deploy',
          body: 'Body',
        }),
      ]);

      const servers = await face.enabledMcpServers();
      expect(servers['plugin-demo:finance']).toEqual(
        expect.objectContaining({
          command: 'finance-mcp',
          cwd: managedRoot,
          enabled: true,
          env: expect.objectContaining({
            CUSTOM: '1',
            KIMI_CODE_HOME: home,
            KIMI_PLUGIN_ROOT: managedRoot,
          }),
        }),
      );
      expect(servers['plugin-demo:docs']).toEqual(
        expect.objectContaining({ transport: 'http', url: 'https://example.com/mcp' }),
      );
      expect(JSON.stringify(servers['plugin-demo:docs'])).not.toContain('KIMI_PLUGIN_ROOT');

      const summaries = await face.listPlugins();
      expect(summaries[0]).toEqual(
        expect.objectContaining({
          skillCount: 1,
          mcpServerCount: 2,
          enabledMcpServerCount: 2,
          hookCount: 1,
          commandCount: 1,
        }),
      );

      await face.setPluginMcpServerEnabled('demo', 'finance', false);
      const afterToggle = await face.enabledMcpServers();
      expect(afterToggle).not.toHaveProperty('plugin-demo:finance');
      const entries = await face.mcpServerEntries();
      expect(entries).toHaveLength(2);
      expect(entries.find((entry) => entry.name === 'plugin-demo:finance')).toEqual(
        expect.objectContaining({
          pluginId: 'demo',
          serverName: 'finance',
          config: expect.objectContaining({ enabled: false }),
        }),
      );
      expect(entries.find((entry) => entry.name === 'plugin-demo:docs')?.config).toEqual(
        expect.objectContaining({ enabled: true }),
      );
      expect((await face.listPlugins())[0]).toEqual(
        expect.objectContaining({ mcpServerCount: 2, enabledMcpServerCount: 1 }),
      );

      await face.setPluginEnabled('demo', false);
      await expect(face.pluginSkillRoots()).resolves.toEqual([]);
      await expect(face.pluginAgentRoots()).resolves.toEqual([]);
      await expect(face.enabledSessionStarts()).resolves.toEqual([]);
      await expect(face.enabledSystemPrompts()).resolves.toEqual([]);
      await expect(face.enabledHooks()).resolves.toEqual([]);
      await expect(face.enabledMcpServers()).resolves.toEqual({});
      const disabledEntries = await face.mcpServerEntries();
      expect(disabledEntries).toHaveLength(2);
      expect(disabledEntries.every((entry) => entry.config.enabled === false)).toBe(true);
    } finally {
      await app.disposeAsync();
    }
  });

  it('degrades consumption reads to fallbacks when installed.json is corrupt and recovers through reloadPlugins', async () => {
    await mkdir(join(home, 'plugins'), { recursive: true });
    await writeFile(join(home, 'plugins', 'installed.json'), '{ not json', 'utf8');
    const { app, face } = await startPluginApp();
    try {
      await expect(face.pluginSkillRoots()).resolves.toEqual([]);
      await expect(face.pluginAgentRoots()).resolves.toEqual([]);
      await expect(face.enabledSessionStarts()).resolves.toEqual([]);
      await expect(face.enabledSystemPrompts()).resolves.toEqual([]);
      await expect(face.enabledHooks()).resolves.toEqual([]);
      await expect(face.enabledMcpServers()).resolves.toEqual({});
      expect(face.hasLoadedSnapshot()).toBe(false);

      const failure = await face.listPlugins().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PluginError);
      expect((failure as PluginError).code).toBe('plugin.load_failed');
      expect((failure as PluginError).message).toContain(
        `Plugin state failed to load: Failed to parse ${join(home, 'plugins', 'installed.json')}: `,
      );
      expect((failure as PluginError).message).toContain(
        `Fix the file at ${home}/plugins/installed.json and run /plugins reload.`,
      );

      const pluginRoot = await makePlugin('recovery-demo', {});
      await writeFile(
        join(home, 'plugins', 'installed.json'),
        JSON.stringify({
          version: 1,
          plugins: [
            {
              id: 'recovery-demo',
              root: pluginRoot,
              source: 'local-path',
              enabled: true,
              installedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
        'utf8',
      );

      await expect(face.listPlugins()).rejects.toMatchObject({ code: 'plugin.load_failed' });
      await expect(face.reloadPlugins()).resolves.toEqual({
        added: ['recovery-demo'],
        removed: [],
        errors: [],
      });
      await expect(face.listPlugins()).resolves.toEqual([
        expect.objectContaining({ id: 'recovery-demo' }),
      ]);
      expect(face.hasLoadedSnapshot()).toBe(true);
    } finally {
      await app.disposeAsync();
    }
  });
});

describe('plugin skill source and profile finder integration', () => {
  it('refreshes the skill catalog with plugin skills after install', async () => {
    const { app, face } = await startPluginApp([
      createSkill({ workDir, fs: host.fs, home: brandHome }),
    ]);
    try {
      const pluginRoot = await makePlugin('demo', { skills: ['demo-skill'] });
      await face.installPlugin(pluginRoot);
      const catalog = app.resolve(SkillCatalogRef);
      await waitFor(() => catalog.get('demo-skill') !== undefined);
      const skill = catalog.get('demo-skill');
      expect(skill?.plugin?.id).toBe('demo');
      expect(skill?.source).toBe('extra');
    } finally {
      await app.disposeAsync();
    }
  });

  it('contributes plugin agent profiles to the profiles catalog', async () => {
    const { app, face } = await startPluginApp([
      createProfiles({ workDir, home: brandHome }),
    ]);
    try {
      const pluginRoot = await makePlugin('demo', { agents: ['demo-agent'] });
      await face.installPlugin(pluginRoot);
      const catalog = app.resolve(ProfileCatalogRef);
      await waitFor(() => catalog.get('demo-agent') !== undefined);
      const inspection = catalog.inspect('demo-agent');
      expect(inspection?.sourceId).toBe('plugin');
      expect(inspection?.priority).toBe(5);
    } finally {
      await app.disposeAsync();
    }
  });
});

describe('plugin agent reminders', () => {
  it('drains a plugin-change reminder into history after a mutation once a tool turn runs', async () => {
    const env = await startAgentApp();
    try {
      const pluginRoot = await makePlugin('demo', { skills: ['demo-skill'] });
      await env.face.installPlugin(pluginRoot);
      await env.runTurn('run');

      const reminders = reminderTexts(env.stores, 'plugin-change');
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toContain('Plugin "demo" was installed.');
      expect(reminders[0]).toContain('run /new or /reload to apply the change');
    } finally {
      await env.dispose();
    }
  });

  it('renders the plugin session-start block once and keeps it across later turns', async () => {
    const env = await startAgentApp();
    try {
      const pluginRoot = await makePlugin('demo', {
        skills: ['demo-skill'],
        skillContents: { 'demo-skill': 'Do the demo thing.' },
        skillInstructions: 'Always be helpful.',
        sessionStartSkill: 'demo-skill',
      });
      await env.face.installPlugin(pluginRoot);
      await env.runTurn('run');
      const reminders = reminderTexts(env.stores, 'plugin-session-start');
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toContain('<plugin_session_start plugin="demo" skill="demo-skill">');
      expect(reminders[0]).toContain('Do the demo thing.');
      expect(reminders[0]).toContain('Always be helpful.');
      expect(reminders[0]).toContain('</plugin_session_start>');

      await env.runTurn('run');
      expect(reminderTexts(env.stores, 'plugin-session-start')).toHaveLength(1);
    } finally {
      await env.dispose();
    }
  });

  it('keeps the frozen reminder after a mutation but neutralizes it after an explicit reload', async () => {
    const env = await startAgentApp();
    try {
      const pluginRoot = await makePlugin('demo', {
        skills: ['demo-skill'],
        skillContents: { 'demo-skill': 'Do the demo thing.' },
        sessionStartSkill: 'demo-skill',
      });
      await env.face.installPlugin(pluginRoot);
      await env.runTurn('run');
      expect(reminderTexts(env.stores, 'plugin-session-start')).toHaveLength(1);

      await env.face.setPluginEnabled('demo', false);
      await env.runTurn('run');
      expect(reminderTexts(env.stores, 'plugin-session-start')).toHaveLength(1);
      expect(reminderTexts(env.stores, 'plugin-change').at(-1)).toContain(
        'Plugin "demo" was disabled.',
      );

      await env.face.reloadPlugins();
      await env.runTurn('run');
      const reminders = reminderTexts(env.stores, 'plugin-session-start');
      expect(reminders).toHaveLength(2);
      expect(reminders[1]).toContain('There are currently no active plugin session starts.');
      expect(reminders[1]).toContain(
        'This supersedes any earlier plugin_session_start reminder in this session.',
      );
    } finally {
      await env.dispose();
    }
  });

  it('does not re-inject the frozen session-start reminder across an agent remount', async () => {
    const env = await startAgentApp();
    try {
      const pluginRoot = await makePlugin('demo', {
        skills: ['demo-skill'],
        skillContents: { 'demo-skill': 'Do the demo thing.' },
        sessionStartSkill: 'demo-skill',
      });
      await env.face.installPlugin(pluginRoot);
      await env.runTurn('run');
      const before = reminderTexts(env.stores, 'plugin-session-start');
      expect(before).toHaveLength(1);

      await env.recreateMain();
      await env.runTurn('run');
      expect(reminderTexts(env.stores, 'plugin-session-start')).toEqual(before);
    } finally {
      await env.dispose();
    }
  });
});

describe('plugin marketplace', () => {
  const location = (resolved: string, kind: 'remote' | 'local' = 'local'): MarketplaceLocation => ({
    raw: resolved,
    kind,
    resolved,
  });

  it('parses entries with fallbacks, tier and type validation, and github-derived versions', () => {
    const marketplace = parsePluginMarketplace(
      JSON.stringify({
        version: '1',
        plugins: [
          {
            id: 'alpha',
            source: 'https://github.com/owner/alpha/releases/tag/v1.2.3',
            tier: 'official',
            description: 'Alpha',
          },
          {
            id: 'beta',
            url: 'https://downloads.example.test/beta.zip',
            name: 'Beta Name',
            shortDescription: 'short',
            websiteURL: 'https://beta.example.test',
            keywords: [' a ', '', 'b'],
          },
        ],
      }),
      location('https://code.kimi.com/plugins/marketplace.json', 'remote'),
    );
    expect(marketplace.version).toBe('1');
    expect(marketplace.plugins[0]).toEqual({
      id: 'alpha',
      displayName: 'alpha',
      source: 'https://github.com/owner/alpha/releases/tag/v1.2.3',
      tier: 'official',
      version: '1.2.3',
      description: 'Alpha',
      homepage: undefined,
      keywords: undefined,
    });
    expect(marketplace.plugins[1]).toEqual({
      id: 'beta',
      displayName: 'Beta Name',
      source: 'https://downloads.example.test/beta.zip',
      tier: undefined,
      version: undefined,
      description: 'short',
      homepage: 'https://beta.example.test',
      keywords: ['a', 'b'],
    });

    const relative = parsePluginMarketplace(
      JSON.stringify({ plugins: [{ id: 'x', source: 'plugins/x.zip' }] }),
      location('https://code.kimi.com/plugins/marketplace.json', 'remote'),
    );
    expect(relative.plugins[0]?.source).toBe('https://code.kimi.com/plugins/plugins/x.zip');

    expect(() => parsePluginMarketplace('{ nope', location('x'))).toThrow(
      'Plugin marketplace is not valid JSON:',
    );
    expect(() => parsePluginMarketplace('[]', location('x'))).toThrow(
      'Plugin marketplace must be an object.',
    );
    expect(() => parsePluginMarketplace('{}', location('x'))).toThrow(
      'Plugin marketplace must contain a "plugins" array.',
    );
    expect(() =>
      parsePluginMarketplace(JSON.stringify({ plugins: [{}] }), location('x')),
    ).toThrow('Plugin marketplace entry 1 must define "id".');
    expect(() =>
      parsePluginMarketplace(JSON.stringify({ plugins: [{ id: 'a' }] }), location('x')),
    ).toThrow('Plugin marketplace entry a must define "source".');
    expect(() =>
      parsePluginMarketplace(
        JSON.stringify({ plugins: [{ id: 'a', source: 's', tier: 'gold' }] }),
        location('x'),
      ),
    ).toThrow('Plugin marketplace entry a "tier" must be one of: official, curated.');
    expect(() =>
      parsePluginMarketplace(
        JSON.stringify({ plugins: [{ id: 'a', source: 's', type: 'tool' }] }),
        location('x'),
      ),
    ).toThrow(
      'Plugin marketplace entry a "type" must be "plugin". Legacy aliases "managed" and "guide" are also accepted.',
    );
  });

  it('resolves marketplace locations for remote, file://, ~, relative, and empty sources', () => {
    expect(resolveMarketplaceLocation(' https://example.test/m.json ', workDir)).toEqual({
      raw: 'https://example.test/m.json',
      kind: 'remote',
      resolved: 'https://example.test/m.json',
    });
    const fileUrl = pathToFileURL(join(workDir, 'm.json')).href;
    expect(resolveMarketplaceLocation(fileUrl, workDir)).toEqual({
      raw: fileUrl,
      kind: 'local',
      resolved: join(workDir, 'm.json'),
    });
    expect(resolveMarketplaceLocation('m.json', workDir)).toEqual({
      raw: 'm.json',
      kind: 'local',
      resolved: join(workDir, 'm.json'),
    });
    expect(resolveMarketplaceLocation('~/m.json', workDir, homedir())).toEqual({
      raw: '~/m.json',
      kind: 'local',
      resolved: join(homedir(), 'm.json'),
    });
    expect(() => resolveMarketplaceLocation('   ', workDir)).toThrow(
      `${KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV} cannot be empty.`,
    );
  });

  it('computes update status with semver semantics', () => {
    expect(computeUpdateStatus('1.1.0', '1.0.0', false)).toEqual({ kind: 'not-installed' });
    expect(computeUpdateStatus('1.1.0', '1.0.0', true)).toEqual({
      kind: 'update',
      local: '1.0.0',
      latest: '1.1.0',
    });
    expect(computeUpdateStatus('1.0.0', '1.1.0', true)).toEqual({
      kind: 'up-to-date',
      version: '1.1.0',
    });
    expect(computeUpdateStatus('not-semver', '1.0.0', true)).toEqual({
      kind: 'up-to-date',
      version: '1.0.0',
    });
    expect(computeUpdateStatus(undefined, '1.0.0', true)).toEqual({
      kind: 'up-to-date',
      version: '1.0.0',
    });
  });

  it('reads a local marketplace file through the host fs and falls back to the checkout location', async () => {
    const file = join(workDir, 'marketplace.json');
    await writeFile(file, JSON.stringify({ plugins: [] }), 'utf8');
    const read = await readPluginMarketplace(host.fs, { source: 'marketplace.json', workDir });
    expect(read.location).toEqual({ raw: 'marketplace.json', kind: 'local', resolved: file });
    expect(JSON.parse(read.raw)).toEqual({ plugins: [] });

    const fallbackFile = join(workDir, 'fallback.json');
    await writeFile(
      fallbackFile,
      JSON.stringify({ plugins: [{ id: 'x', source: 'https://example.test/x.zip' }] }),
      'utf8',
    );
    const fellBack = await readPluginMarketplace(host.fs, {
      source: 'missing.json',
      workDir,
      sourceCheckoutLocation: async () => ({
        raw: 'fallback.json',
        kind: 'local',
        resolved: fallbackFile,
      }),
    });
    expect(fellBack.location.resolved).toBe(fallbackFile);
    await expect(
      readPluginMarketplace(host.fs, { source: 'missing.json', workDir }),
    ).rejects.toThrow();
  });

  it('appends built-in entries after the catalog and enriches their versions from it', () => {
    const marketplace = parsePluginMarketplace(
      JSON.stringify({
        plugins: [
          { id: 'keep', source: 'https://example.test/keep.zip' },
          { id: 'builtin-a', source: 'https://example.test/a.zip', version: '2.0.0' },
        ],
      }),
      location('https://example.test/m.json', 'remote'),
    );
    const merged = withBuiltInEntries(marketplace, [
      { id: 'builtin-a', displayName: 'A', source: 'builtin:a', builtIn: true },
      { id: 'builtin-b', displayName: 'B', source: 'builtin:b', builtIn: true },
    ]);
    expect(merged.plugins.map((entry) => entry.id)).toEqual(['keep', 'builtin-a', 'builtin-b']);
    expect(merged.plugins[1]).toEqual(
      expect.objectContaining({ id: 'builtin-a', version: '2.0.0', builtIn: true }),
    );
    expect(merged.plugins[2]?.version).toBeUndefined();
  });

  it('fills latest versions from github releases without touching pinned or foreign entries', async () => {
    const marketplace = parsePluginMarketplace(
      JSON.stringify({
        plugins: [
          { id: 'a', source: 'https://github.com/owner/a' },
          { id: 'b', source: 'https://github.com/owner/b', version: '0.9.0' },
          { id: 'c', source: 'https://downloads.example.test/c.zip' },
        ],
      }),
      location('https://example.test/m.json', 'remote'),
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://github.com/owner/a/releases/latest') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/owner/a/releases/tag/v1.2.3' },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const enriched = await withLatestVersions(marketplace, fetchImpl as typeof fetch);
    expect(enriched.plugins.map((entry) => [entry.id, entry.version])).toEqual([
      ['a', '1.2.3'],
      ['b', '0.9.0'],
      ['c', undefined],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('managed kimi env injection for plugin mcp servers', () => {
  function bindProviderCatalog(info: CatalogProviderInfo): FeatureSpec {
    return createFeature('test-provider-catalog', {
      app() {
        const providers = new Map([[KIMI_CODE_PROVIDER_NAME, info]]);
        useExpose(ProviderCatalogRef, {
          snapshot: () => ({ providers: {} }),
          providers: () => [...providers.keys()],
          providerInfo: (providerId) => providers.get(providerId),
          models: () => [],
          model: () => undefined,
          requester: () => undefined,
          upsert: () => {},
          bind: () => {},
          remove: () => {},
          refresh: () => {},
          ping: () => {},
          onChanged: () => () => {},
          onRefreshFailed: () => () => {},
          isLive: (providerId) => providers.has(providerId),
          close: () => {},
        } satisfies ProviderCatalogFace);
      },
    });
  }

  async function installMcpPlugin(face: PluginFace): Promise<string> {
    const pluginRoot = await makePlugin('demo', {
      mcpServers: {
        finance: { command: 'finance-mcp', env: { CUSTOM: '1' } },
        docs: { url: 'https://example.com/mcp' },
      },
    });
    await face.installPlugin(pluginRoot);
    return realpath(join(home, 'plugins', 'managed', 'demo'));
  }

  it('injects env-override endpoints ahead of the provider catalog into stdio servers only', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://env.example.test/');
    vi.stubEnv('KIMI_OAUTH_HOST', 'https://legacy.example.test');
    const { app, face } = await startPluginApp([
      bindProviderCatalog({
        baseUrl: 'https://api.example.test/',
        oauth: { storage: 'file', key: 'kimi', oauthHost: 'https://auth.example.test' },
      }),
    ]);
    try {
      const managedRoot = await installMcpPlugin(face);
      const servers = await face.enabledMcpServers();
      expect(servers['plugin-demo:finance']).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            KIMI_CODE_BASE_URL: 'https://env.example.test',
            KIMI_CODE_OAUTH_HOST: 'https://legacy.example.test',
            CUSTOM: '1',
            KIMI_CODE_HOME: home,
            KIMI_PLUGIN_ROOT: managedRoot,
          }),
        }),
      );
      expect(JSON.stringify(servers['plugin-demo:docs'])).not.toContain('KIMI_CODE_BASE_URL');
    } finally {
      await app.disposeAsync();
    }
  });

  it('falls back to the provider catalog endpoints when no env override is present', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', undefined);
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', undefined);
    vi.stubEnv('KIMI_OAUTH_HOST', undefined);
    const { app, face } = await startPluginApp([
      bindProviderCatalog({
        baseUrl: 'https://api.example.test/',
        oauth: { storage: 'file', key: 'kimi', oauthHost: 'https://auth.example.test' },
      }),
    ]);
    try {
      await installMcpPlugin(face);
      const servers = await face.enabledMcpServers();
      expect(servers['plugin-demo:finance']).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            KIMI_CODE_BASE_URL: 'https://api.example.test/',
            KIMI_CODE_OAUTH_HOST: 'https://auth.example.test',
          }),
        }),
      );
      expect(JSON.stringify(servers['plugin-demo:docs'])).not.toContain('KIMI_CODE_BASE_URL');
    } finally {
      await app.disposeAsync();
    }
  });

  it('does not inject when neither env nor the managed provider supplies endpoints', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', undefined);
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', undefined);
    vi.stubEnv('KIMI_OAUTH_HOST', undefined);
    const { app, face } = await startPluginApp();
    try {
      await installMcpPlugin(face);
      const servers = await face.enabledMcpServers();
      const env = (servers['plugin-demo:finance'] as { env?: Record<string, string> }).env ?? {};
      expect(env['CUSTOM']).toBe('1');
      expect(env).not.toHaveProperty('KIMI_CODE_BASE_URL');
      expect(env).not.toHaveProperty('KIMI_CODE_OAUTH_HOST');
    } finally {
      await app.disposeAsync();
    }
  });

  it('decorates mcpServerEntries with the same managed env merge', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://env.example.test/');
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.example.test');
    const { app, face } = await startPluginApp();
    try {
      const managedRoot = await installMcpPlugin(face);
      await face.setPluginMcpServerEnabled('demo', 'finance', false);
      const entries = await face.mcpServerEntries();
      expect(entries.find((entry) => entry.name === 'plugin-demo:finance')?.config).toEqual(
        expect.objectContaining({
          enabled: false,
          env: expect.objectContaining({
            KIMI_CODE_BASE_URL: 'https://env.example.test',
            KIMI_CODE_OAUTH_HOST: 'https://auth.example.test',
            CUSTOM: '1',
            KIMI_CODE_HOME: home,
            KIMI_PLUGIN_ROOT: managedRoot,
          }),
        }),
      );
      const docs = entries.find((entry) => entry.name === 'plugin-demo:docs');
      expect(docs?.config).toEqual(expect.objectContaining({ enabled: true }));
      expect(JSON.stringify(docs?.config)).not.toContain('KIMI_CODE_BASE_URL');
    } finally {
      await app.disposeAsync();
    }
  });
});

describe('plugin mcp server source contribution', () => {
  it('contributes plugin mcp servers to the mcp feature and drives reload on mutation', async () => {
    const mcpHome = await realpath(await mkdtemp(join(tmpdir(), 'plugin-mcp-home-')));
    tempDirs.push(mcpHome);
    const pluginFeature = createPlugin({ homeDir: home, host });
    const app = createHarness({
      features: [pluginFeature, createMcp({ workDir, home: mcpHome, host })],
    });
    await app.ready();
    try {
      const face = app.resolve(PluginRef);
      const mcp = app.resolve(McpRef);
      const pluginRoot = await makePlugin('demo', {
        mcpServers: {
          finance: { command: 'definitely-not-a-real-command-xyz', deferred: true },
        },
      });
      await face.installPlugin(pluginRoot);

      await waitFor(() => mcp.list().some((entry) => entry.name === 'plugin-demo:finance'));
      const contributed = mcp.list().find((entry) => entry.name === 'plugin-demo:finance');
      expect(contributed?.transport).toBe('stdio');
      expect(contributed?.status).toBe('failed');

      await face.setPluginMcpServerEnabled('demo', 'finance', false);
      await waitFor(() => {
        const entry = mcp.list().find((candidate) => candidate.name === 'plugin-demo:finance');
        return entry === undefined || entry.status === 'removed';
      });
    } finally {
      await app.disposeAsync();
    }
  });
});
