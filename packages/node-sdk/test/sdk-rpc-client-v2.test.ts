/**
 * Scenario: v2 wiring MVP — the harness talks to the in-process agent-core-v2
 * engine (klient memory transport) instead of the v1 KimiCore RPC pair.
 * Responsibilities: `getExperimentalFeatures` is migrated end-to-end; every
 * not-yet-migrated method fails loudly with `not_implemented` instead of
 * silently hitting a v1 core.
 * Wiring: real v2 engine bootstrapped on a temp KIMI_CODE_HOME; no provider calls.
 * Run: pnpm exec vitest run test/sdk-rpc-client-v2.test.ts
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createKimiHarnessV2,
  ErrorCodes,
  KimiError,
  KimiHarness,
  removeProviderFromConfig,
  SDKRpcClientV2,
  type KimiConfig,
} from '#/index';
import { foldAgentWireReplay } from '#/v2/resume-replay';
import { IHostRequestHeaders } from '@moonshot-ai/agent-core-v2';

import { TEST_IDENTITY } from './test-identity';
import { recordingTelemetry, type TelemetryRecord } from './telemetry';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeHarness(): Promise<{ harness: KimiHarness; homeDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
  tempDirs.push(homeDir);
  return { harness: createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY }), homeDir };
}

describe('SDKRpcClientV2 (agent-core-v2 wiring MVP)', () => {
  it('seeds the host request headers (User-Agent + X-Msh-*) into the engine', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      // Without this seed the managed vendors go out with the SDK's default
      // User-Agent and no X-Msh-* — the interactive-v2 path's identity bug.
      const headers = client.engineAccessor.get(IHostRequestHeaders).headers;
      expect(headers['User-Agent']).toBe(`kimi-code-cli/${TEST_IDENTITY.version}`);
      expect(headers['X-Msh-Platform']).toBe('kimi_code_cli');
      expect(headers['X-Msh-Version']).toBe(TEST_IDENTITY.version);
      expect(headers['X-Msh-Device-Id']).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it('serves getExperimentalFeatures from the v2 engine', async () => {
    const { harness } = await makeHarness();
    try {
      const features = await harness.getExperimentalFeatures();
      expect(Array.isArray(features)).toBe(true);
      expect(features.length).toBeGreaterThan(0);
      for (const feature of features) {
        expect(typeof feature.id).toBe('string');
        expect(typeof feature.title).toBe('string');
        expect(typeof feature.env).toBe('string');
        expect(typeof feature.enabled).toBe('boolean');
        expect(typeof feature.defaultEnabled).toBe('boolean');
      }
    } finally {
      await harness.close();
    }
  });

  it('serves listWorkspaceSkills through the engineAccessor escape hatch', async () => {
    const { harness, homeDir } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    await writeSkill(join(homeDir, 'skills', 'demo-user-skill'), 'demo-user-skill');
    await writeSkill(join(workDir, '.kimi-code', 'skills', 'demo-project-skill'), 'demo-project-skill');
    try {
      const skills = await harness.listWorkspaceSkills(workDir);
      const byName = new Map(skills.map((skill) => [skill.name, skill]));
      expect(byName.get('demo-user-skill')).toMatchObject({
        description: 'Skill demo-user-skill for the escape-hatch test',
        source: 'user',
      });
      expect(byName.get('demo-project-skill')).toMatchObject({
        description: 'Skill demo-project-skill for the escape-hatch test',
        source: 'project',
      });
    } finally {
      await harness.close();
    }
  });

  it('honors skillDirs (explicit dirs) over default user / project discovery', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    const explicitBase = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-explicit-'));
    tempDirs.push(explicitBase);
    const explicitDir = join(explicitBase, 'skills');
    await writeSkill(join(homeDir, 'skills', 'demo-user-skill'), 'demo-user-skill');
    await writeSkill(join(workDir, '.kimi-code', 'skills', 'demo-project-skill'), 'demo-project-skill');
    await writeSkill(join(explicitDir, 'demo-explicit-skill'), 'demo-explicit-skill');
    const harness = createKimiHarnessV2({
      homeDir,
      identity: TEST_IDENTITY,
      skillDirs: [explicitDir],
    });
    try {
      const skills = await harness.listWorkspaceSkills(workDir);
      const byName = new Map(skills.map((skill) => [skill.name, skill]));
      expect(byName.get('demo-explicit-skill')).toMatchObject({
        description: 'Skill demo-explicit-skill for the escape-hatch test',
        source: 'user',
      });
      expect(byName.has('demo-user-skill')).toBe(false);
      expect(byName.has('demo-project-skill')).toBe(false);

      // The session skill catalog (the Skill tool's listing) goes through the
      // seeded engine runtime options, so it sees the same explicit source.
      const session = await harness.createSession({ workDir });
      const sessionNames = new Set((await session.listSkills()).map((skill) => skill.name));
      expect(sessionNames.has('demo-explicit-skill')).toBe(true);
      expect(sessionNames.has('demo-user-skill')).toBe(false);
      expect(sessionNames.has('demo-project-skill')).toBe(false);
      await session.close();
    } finally {
      await harness.close();
    }
  });

  it('serves the plugin catalog from the v2 engine on an empty home', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-'));
    tempDirs.push(homeDir);
    const rpc = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });
    try {
      expect(await rpc.listPlugins()).toEqual([]);
      expect(await rpc.reloadPlugins()).toEqual({ added: [], removed: [], errors: [] });
      await expect(rpc.getPluginInfo('missing-plugin')).rejects.toThrow();
    } finally {
      await rpc.close();
    }
  });

  it('persists removeProvider as one atomic cascade (providers, models, defaults)', async () => {
    const { harness } = await makeHarness();
    try {
      await harness.setConfig({
        providers: {
          a: { type: 'openai', baseUrl: 'https://a.example.test/v1', apiKey: 'sk-a' },
          b: { type: 'openai', baseUrl: 'https://b.example.test/v1', apiKey: 'sk-b' },
        },
        models: {
          'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 },
          'b/m1': { provider: 'b', model: 'm1', maxContextSize: 100 },
        },
        defaultModel: 'b/m1',
        defaultProvider: 'b',
      });
      const next = await harness.removeProvider('b');
      expect(next.providers['b']).toBeUndefined();
      expect(next.providers['a']).toBeDefined();
      expect(next.models?.['b/m1']).toBeUndefined();
      expect(next.models?.['a/m1']).toBeDefined();
      expect(next.defaultModel).toBeUndefined();
      expect(next.defaultProvider).toBeUndefined();
      // A fresh read from disk sees the same state — the cascade landed as a
      // single atomic write, never a halfway-removed intermediate.
      const reread = await harness.getConfig({ reload: true });
      expect(reread.providers['b']).toBeUndefined();
      expect(reread.models?.['b/m1']).toBeUndefined();
      expect(reread.defaultModel).toBeUndefined();
      expect(reread.defaultProvider).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('replaces config sections atomically and clears undefined sections', async () => {
    const { harness } = await makeHarness();
    try {
      expect(harness.supportsAtomicSectionReplace()).toBe(true);
      await harness.setConfig({
        providers: { a: { type: 'openai', baseUrl: 'https://a.example.test/v1', apiKey: 'sk-a' } },
        models: { 'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 } },
        defaultModel: 'a/m1',
      });
      await harness.replaceConfigSections({ defaultModel: undefined });
      const next = await harness.getConfig({ reload: true });
      expect(next.defaultModel).toBeUndefined();
      // Sections absent from the write stay untouched.
      expect(next.providers['a']).toBeDefined();
      expect(next.models?.['a/m1']).toBeDefined();
    } finally {
      await harness.close();
    }
  });

  it('fails loudly with not_implemented for methods not yet migrated', async () => {
    const { harness } = await makeHarness();
    try {
      // `deleteSession` is the permanent case: the v2 engine has no
      // session-deletion capability, so it stays not_implemented by design
      // (tracked in `.tmp/v2-migration-tracker.md`).
      await expect(harness.deleteSession('session_missing')).rejects.toThrowError(KimiError);
      await expect(harness.deleteSession('session_missing')).rejects.toMatchObject({
        code: ErrorCodes.NOT_IMPLEMENTED,
      });
    } finally {
      await harness.close();
    }
  });
});

describe('SDKRpcClientV2 workspace trust', () => {
  it('reports an untrusted workspace with the project MCP servers it gates', async () => {
    const { harness } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    await writeFile(
      join(workDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'root-server': { command: 'root-cmd' } } }),
      'utf-8',
    );
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(
      join(workDir, '.kimi-code', 'mcp.json'),
      JSON.stringify({ mcpServers: { 'nested-server': { command: 'nested-cmd' } } }),
      'utf-8',
    );
    try {
      const info = await harness.getWorkspaceTrustInfo(workDir);
      expect(info.trusted).toBe(false);
      expect(info.gatedMcpServers).toEqual(['nested-server', 'root-server']);
    } finally {
      await harness.close();
    }
  });

  it('degrades the gated-server list to empty on an invalid project mcp.json', async () => {
    const { harness } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    await writeFile(join(workDir, '.mcp.json'), '{not json', 'utf-8');
    try {
      const info = await harness.getWorkspaceTrustInfo(workDir);
      expect(info).toEqual({ trusted: false, gatedMcpServers: [] });
    } finally {
      await harness.close();
    }
  });

  it('trustWorkspace flips the state and persists the marker in the kimi home', async () => {
    const { harness, homeDir } = await makeHarness();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-work-'));
    tempDirs.push(workDir);
    try {
      await harness.trustWorkspace(workDir);
      expect(await harness.getWorkspaceTrustInfo(workDir)).toEqual({
        trusted: true,
        gatedMcpServers: [],
      });
      // The trust marker lives in the kimi home, never in the checkout.
      const markers = await readdir(join(homeDir, 'workspace-trust'));
      expect(markers.length).toBe(1);
      expect(await readdir(workDir)).not.toContain('workspace-trust');
    } finally {
      await harness.close();
    }
  });
});

describe('foldAgentWireReplay', () => {
  it('folds a journal into v1 replay records and the tool store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-fold-'));
    tempDirs.push(dir);
    const wirePath = join(dir, 'wire.jsonl');
    const records = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1000 },
      {
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
        time: 1001,
      },
      { type: 'permission.set_mode', mode: 'auto', time: 1002 },
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'old', status: 'done' }],
        time: 1003,
      },
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'new', status: 'pending' }],
        time: 1004,
      },
      // A v2-only op the v1 restore switch does not know: ignored.
      { type: 'profile.bind', profileName: 'agent', systemPrompt: 'x', thinkingEffort: 'off', disallowedTools: [], time: 1005 },
    ];
    await writeFile(wirePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf-8');
    const folded = await foldAgentWireReplay(wirePath);
    expect(folded.replay).toEqual([
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
        time: 1001,
      },
      { type: 'permission_updated', mode: 'auto', time: 1002 },
    ]);
    // Last write wins per store key.
    expect(folded.toolStore).toEqual({ todo: [{ title: 'new', status: 'pending' }] });
  });

  it('degrades to an empty fold on a missing or corrupt journal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-fold-'));
    tempDirs.push(dir);
    const empty = { replay: [], toolStore: {} };
    await expect(foldAgentWireReplay(join(dir, 'missing.jsonl'))).resolves.toEqual(empty);
    const emptyFile = join(dir, 'empty.jsonl');
    await writeFile(emptyFile, '', 'utf-8');
    await expect(foldAgentWireReplay(emptyFile)).resolves.toEqual(empty);
    const corrupt = join(dir, 'corrupt.jsonl');
    await writeFile(
      corrupt,
      '{"type":"metadata","protocol_version":"1.5","created_at":1}\n{not json\n{"type":"permission.set_mode","mode":"auto"}\n',
      'utf-8',
    );
    await expect(foldAgentWireReplay(corrupt)).resolves.toEqual(empty);
    // A truncated TAIL line is tolerated: everything before it still folds.
    const truncatedTail = join(dir, 'truncated.jsonl');
    await writeFile(
      truncatedTail,
      '{"type":"metadata","protocol_version":"1.5","created_at":1}\n{"type":"permission.set_mode","mode":"auto","time":2}\n{"type":"context.append_messa',
      'utf-8',
    );
    const folded = await foldAgentWireReplay(truncatedTail);
    expect(folded.replay).toEqual([{ type: 'permission_updated', mode: 'auto', time: 2 }]);
  });
});

describe('SDKRpcClientV2 engine telemetry', () => {
  it('forwards engine-side events to the host-supplied telemetry client', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-work-'));
    tempDirs.push(workDir);
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarnessV2({
      homeDir,
      identity: TEST_IDENTITY,
      telemetry: recordingTelemetry(records),
    });
    try {
      const session = await harness.createSession({ workDir });
      await session.setPermission('yolo');
      expect(records.some((record) => record.event === 'yolo_toggle')).toBe(true);
      await session.close();
    } finally {
      await harness.close();
    }
  });

  it('honors telemetry = false for engine-side events', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-off-'));
    tempDirs.push(homeDir);
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-v2-tel-off-work-'));
    tempDirs.push(workDir);
    await writeFile(join(homeDir, 'config.toml'), 'telemetry = false\n', 'utf-8');
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarnessV2({
      homeDir,
      identity: TEST_IDENTITY,
      telemetry: recordingTelemetry(records),
    });
    try {
      const session = await harness.createSession({ workDir });
      await session.setPermission('yolo');
      expect(records.some((record) => record.event === 'yolo_toggle')).toBe(false);
      await session.close();
    } finally {
      await harness.close();
    }
  });
});

describe('removeProviderFromConfig', () => {
  it('drops the provider, its models and dangling default pointers without mutating the input', () => {
    const config = {
      providers: {
        a: { type: 'openai', baseUrl: 'https://a.example.test/v1' },
        b: { type: 'openai', baseUrl: 'https://b.example.test/v1' },
      },
      models: {
        'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 },
        'b/m1': { provider: 'b', model: 'm1', maxContextSize: 100 },
        'my-b': { provider: 'b', model: 'm1', maxContextSize: 100 },
      },
      defaultModel: 'my-b',
      defaultProvider: 'b',
    } as unknown as KimiConfig;

    const next = removeProviderFromConfig(config, 'b');

    expect(Object.keys(next.providers)).toEqual(['a']);
    expect(Object.keys(next.models ?? {})).toEqual(['a/m1']);
    expect(next.defaultModel).toBeUndefined();
    expect(next.defaultProvider).toBeUndefined();
    // The input config is left untouched (the staging host threads the copy).
    expect(config.providers['b']).toBeDefined();
    expect(config.models?.['b/m1']).toBeDefined();
    expect(config.defaultModel).toBe('my-b');
  });

  it('keeps the default pointers when they do not dangle', () => {
    const config = {
      providers: {
        a: { type: 'openai' },
        b: { type: 'openai' },
      },
      models: {
        'a/m1': { provider: 'a', model: 'm1', maxContextSize: 100 },
        'b/m1': { provider: 'b', model: 'm1', maxContextSize: 100 },
      },
      defaultModel: 'a/m1',
      defaultProvider: 'a',
    } as unknown as KimiConfig;

    const next = removeProviderFromConfig(config, 'b');

    expect(Object.keys(next.providers)).toEqual(['a']);
    expect(Object.keys(next.models ?? {})).toEqual(['a/m1']);
    expect(next.defaultModel).toBe('a/m1');
    expect(next.defaultProvider).toBe('a');
  });
});

async function writeSkill(dir: string, name: string): Promise<void> {  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Skill ${name} for the escape-hatch test\n---\n\nBody of ${name}.\n`,
    'utf-8',
  );
}
