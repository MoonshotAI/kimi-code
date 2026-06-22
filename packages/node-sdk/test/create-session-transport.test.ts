import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Kaos } from '@moonshot-ai/kaos';
import { createKimiHarness, KimiHarness } from '#/index';
import type { KimiError } from '#/index';
import type { ResumeSessionInput, ResumedSessionSummary } from '#/types';
import { SDKRpcClientBase } from '#/rpc';
import { afterEach, describe, expect, it } from 'vitest';

import { waitForAgentWireEvent } from './session-runtime-helpers';
import { recordingTelemetry, type TelemetryRecord } from './telemetry';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-create-'));
  tempDirs.push(dir);
  return dir;
}

async function writeTestModelConfig(homeDir: string, modelName = 'kimi-test-model'): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `
[providers.local]
type = "kimi"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models."${modelName}"]
provider = "local"
model = "${modelName}"
max_context_size = 1000
`,
    'utf-8',
  );
}

class StubRpc extends SDKRpcClientBase {
  resumeCalls: Array<{ input: ResumeSessionInput; kaos: Kaos; persistenceKaos?: Kaos }> = [];

  protected async getRpc(): Promise<never> {
    throw new Error('not used');
  }

  override async createSession(input: { id?: string; workDir: string }) {
    return {
      id: input.id ?? 'ses_stub',
      workDir: input.workDir,
      sessionDir: '/tmp/session',
      createdAt: 1,
      updatedAt: 1,
    };
  }

  override async resumeSessionWithKaos(input: ResumeSessionInput, kaos: Kaos, persistenceKaos?: Kaos): Promise<ResumedSessionSummary> {
    this.resumeCalls.push({ input, kaos, persistenceKaos });
    return {
      id: input.id,
      workDir: '/tmp/work',
      sessionDir: '/tmp/session',
      createdAt: 1,
      updatedAt: 1,
      sessionMetadata: {
        createdAt: '',
        updatedAt: '',
        title: '',
        isCustomTitle: false,
        agents: {},
        custom: {},
      },
      agents: {},
    };
  }
}

describe('KimiHarness.createSession transport link', () => {
  it('emits session_started with client attribution when a session is opened', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    try {
      const session = await harness.createSession({
        id: 'ses_session_started',
        workDir,
      });
      await harness.resumeSession({ id: session.id });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
        },
      });
      expect(records.filter((record) => record.event === 'session_started')).toHaveLength(1);
      expect(records).toContainEqual({
        event: 'session_new',
        sessionId: session.id,
        properties: undefined,
      });

      await session.close();
      await harness.resumeSession({ id: session.id });

      expect(records.filter((record) => record.event === 'session_started')).toHaveLength(2);
      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: true,
        },
      });
      expect(records).toContainEqual({
        event: 'session_resume',
        sessionId: session.id,
        properties: undefined,
      });
    } finally {
      await harness.close();
    }
  });

  it('uses the configured UI mode for session_started attribution', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
      uiMode: 'print',
    });

    try {
      const session = await harness.createSession({
        id: 'ses_session_started_print',
        workDir,
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'print',
          resumed: false,
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('merges process-level sessionStartedProperties into session_started', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
      sessionStartedProperties: { yolo: true, plan: false },
    });

    try {
      const session = await harness.createSession({
        id: 'ses_process_props',
        workDir,
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
          yolo: true,
          plan: false,
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('merges session-level sessionStartedProperties and overrides process-level ones', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
      sessionStartedProperties: { mode: 'process', source: 'process' },
    });

    try {
      const session = await harness.createSession({
        id: 'ses_scoped_props',
        workDir,
        sessionStartedProperties: { mode: 'new' },
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
          mode: 'new',
          source: 'process',
        },
      });

      await session.close();
      await harness.resumeSession({
        id: session.id,
        sessionStartedProperties: { mode: 'load' },
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: true,
          mode: 'load',
          source: 'process',
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('does not let sessionStartedProperties override canonical session_started fields', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    try {
      const session = await harness.createSession({
        id: 'ses_reserved_keys',
        workDir,
        sessionStartedProperties: {
          client_name: 'evil',
          client_version: 'evil',
          ui_mode: 'evil',
          resumed: true,
          extra: 'kept',
        },
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
          extra: 'kept',
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('emits session_fork with the forked session context', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    try {
      const source = await harness.createSession({
        id: 'ses_fork_source',
        workDir,
      });
      const forked = await harness.forkSession({
        id: source.id,
        forkId: 'ses_fork_child',
        title: 'Forked child',
      });

      expect(forked.id).toBe('ses_fork_child');
      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: forked.id,
        properties: {
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: true,
        },
      });
      expect(records).toContainEqual({
        event: 'session_fork',
        sessionId: forked.id,
        properties: undefined,
      });
    } finally {
      await harness.close();
    }
  });

  it('does not invent client attribution without host identity', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    try {
      const session = await harness.createSession({
        id: 'ses_session_started_shell',
        workDir,
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_name: null,
          client_version: null,
          ui_mode: 'shell',
          resumed: false,
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('creates metadata and keeps the session active in the harness', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_transport_link',
        workDir,
        model: 'kimi-test-model',
      });

      expect(session.id).toBe('ses_transport_link');
      expect(session.workDir).toBe(workDir);
      await expect(session.getStatus()).resolves.toMatchObject({ model: 'kimi-test-model' });
      expect(harness.sessions.get(session.id)).toBe(session);
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'kimi-test-model',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'kimi-test-model',
      });
      expect(configEvent).not.toHaveProperty('provider');

      const summaries = await harness.listSessions({ workDir });
      const summary = summaries.find((item) => item.id === session.id);
      expect(summary?.sessionDir).not.toBe(join(homeDir, 'sessions', session.id));
      expect(summary?.sessionDir).toContain(join(homeDir, 'sessions'));
      expect(existsSync(join(summary!.sessionDir, 'state.json'))).toBe(true);
      expect(await readFile(join(homeDir, 'session_index.jsonl'), 'utf-8')).toContain(session.id);

      const summariesById = await harness.listSessions({ sessionId: session.id });
      expect(summariesById).toHaveLength(1);
      expect(summariesById[0]).toMatchObject({
        id: session.id,
        workDir,
      });
      await expect(harness.listSessions({ sessionId: 'ses_missing' })).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('accepts configured model aliases while creating the core session', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "alias-model"

[providers.local]
type = "openai"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models.alias-model]
provider = "local"
model = "real-model"
max_context_size = 1000

[thinking]
effort = "medium"
`,
      'utf-8',
    );
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_alias_model', workDir });
      expect(session.id).toBe('ses_alias_model');
      await expect(session.getStatus()).resolves.toMatchObject({ model: 'alias-model' });
      expect(harness.sessions.get(session.id)).toBe(session);
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'alias-model',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'alias-model',
      });
      expect(configEvent).not.toHaveProperty('provider');
    } finally {
      await harness.close();
    }
  });

  it('does not require provider config or API keys before prompt is implemented', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_empty_config', workDir });
      expect(session.id).toBe('ses_empty_config');
      expect((await session.getStatus()).model).toBeUndefined();
      expect(harness.sessions.get(session.id)).toBe(session);
    } finally {
      await harness.close();
    }
  });

  it('requires a non-empty workDir on createSession', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await expect(
        harness.createSession({ id: 'ses_missing_workdir' } as never),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
      } satisfies Partial<KimiError>);
      await expect(
        harness.createSession({ id: 'ses_blank_workdir', workDir: '   ' }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('does not persist a session record when MCP config validation fails', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    // Project-local mcp.json is intentionally ignored, so plant the malformed
    // file under the user home dir where the loader actually reads from.
    await writeFile(join(homeDir, 'mcp.json'), '{not json}', 'utf-8');
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(
        harness.createSession({ id: 'ses_bad_mcp_config', workDir }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'config.invalid',
      });
      expect(await harness.listSessions({ workDir })).toEqual([]);
      expect(existsSync(join(homeDir, 'session_index.jsonl'))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('closes active runtime handles through closeSession, session.close, and close', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    const first = await harness.createSession({
      id: 'ses_close_one',
      workDir,
      model: 'kimi-test-model',
    });
    const second = await harness.createSession({
      id: 'ses_close_two',
      workDir,
      model: 'kimi-test-model',
    });
    expect(coreSessionIds(harness)).toEqual([first.id, second.id]);

    await harness.closeSession(first.id);
    expect(harness.getSession(first.id)).toBeUndefined();
    expect(coreSessionIds(harness)).toEqual([second.id]);

    await second.close();
    expect(harness.getSession(second.id)).toBeUndefined();
    expect(coreSessionIds(harness)).toEqual([]);

    await harness.close();
    expect(harness.sessions.size).toBe(0);
    expect(coreSessionIds(harness)).toEqual([]);
  });

  it('applies initial thinking and permission runtime options', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_initial_runtime_options',
        workDir,
        thinking: 'low',
        permission: 'auto',
      });

      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'config.update',
          (event) => event['thinkingLevel'] === 'low',
        ),
      ).resolves.toMatchObject({
        type: 'config.update',
        thinkingLevel: 'low',
      });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'permission.set_mode',
          (event) => event['mode'] === 'auto',
        ),
      ).resolves.toMatchObject({
        type: 'permission.set_mode',
        mode: 'auto',
      });
    } finally {
      await harness.close();
    }
  });

  it('applies configured default permission mode to new sessions', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeFile(join(homeDir, 'config.toml'), 'default_permission_mode = "auto"\n', 'utf-8');
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_default_permission_mode',
        workDir,
      });

      await expect(session.getStatus()).resolves.toMatchObject({ permission: 'auto' });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'permission.set_mode',
          (event) => event['mode'] === 'auto',
        ),
      ).resolves.toMatchObject({
        type: 'permission.set_mode',
        mode: 'auto',
      });

      const explicit = await harness.createSession({
        id: 'ses_default_permission_explicit_override',
        workDir,
        permission: 'manual',
      });
      await expect(explicit.getStatus()).resolves.toMatchObject({ permission: 'manual' });
    } finally {
      await harness.close();
    }
  });

  it('rebinds an active session when resumeSession receives a new Kaos', async () => {
    const records: TelemetryRecord[] = [];
    const rpc = new StubRpc();
    const harness = new KimiHarness(rpc, {
      homeDir: '/tmp/home',
      configPath: '/tmp/config.toml',
      auth: { status: async () => ({ providers: [] }) } as never,
      telemetry: recordingTelemetry(records),
      ensureConfigFile: async () => undefined,
      onClose: () => undefined,
    });

    const session = await harness.createSession({ id: 'ses_active', workDir: '/tmp/work' });
    const kaos = {} as Kaos;

    const resumed = await harness.resumeSession({ id: session.id, kaos });

    expect(resumed).toBe(session);
    expect(rpc.resumeCalls).toHaveLength(1);
    expect(rpc.resumeCalls[0]).toMatchObject({
      input: { id: 'ses_active' },
      kaos,
      persistenceKaos: undefined,
    });
  });
});

function coreSessionIds(harness: KimiHarness): readonly string[] {
  const core = (
    harness as unknown as {
      readonly rpc: { readonly core: { readonly sessions: ReadonlyMap<string, unknown> } };
    }
  ).rpc.core;
  return Array.from(core.sessions.keys()).toSorted();
}
