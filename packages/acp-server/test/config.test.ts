import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestClient, type TestClient } from './_helpers/acpClient';
import { FAKE_MODEL_ALT_ID, writeFakeModelConfig } from './_helpers/fakeModelConfig';

interface ConfigOption {
  readonly id: string;
  readonly currentValue: string;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly name?: string }>;
}

interface ModesState {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<{ readonly id: string }>;
}

interface NewSessionResult {
  readonly sessionId: string;
  readonly configOptions: readonly ConfigOption[];
  readonly modes?: ModesState;
}

describe('acp-server config surface', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function boot(opts?: {
    fakeModel?: boolean;
    thinking?: boolean;
    supportEfforts?: readonly string[];
    defaultEffort?: string;
    altThinking?: boolean;
    altSupportEfforts?: readonly string[];
    altDefaultEffort?: string;
  }): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-config-'));
    if (opts?.fakeModel === true) {
      await writeFakeModelConfig(homeDir, {
        thinking: opts?.thinking === true,
        supportEfforts: opts?.supportEfforts,
        defaultEffort: opts?.defaultEffort,
        altThinking: opts?.altThinking === true,
        altSupportEfforts: opts?.altSupportEfforts,
        altDefaultEffort: opts?.altDefaultEffort,
      });
    }
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  async function newSession(): Promise<NewSessionResult> {
    return (await client!.send('session/new', {
      cwd: homeDir,
      mcpServers: [],
    })) as NewSessionResult;
  }

  it(
    'session/new advertises mode + model pickers (no thinking without a model)',
    async () => {
      await boot();
      const { configOptions } = await newSession();
      const ids = configOptions.map((o) => o.id);
      expect(ids).toContain('mode');
      expect(ids).toContain('model');
      expect(ids).not.toContain('thinking');
      const mode = configOptions.find((o) => o.id === 'mode')!;
      expect(mode.currentValue).toBe('default');
    },
    30_000,
  );

  it(
    'session/new advertises the first-class modes state',
    async () => {
      await boot();
      const { modes } = await newSession();
      expect(modes?.currentModeId).toBe('default');
      expect(modes?.availableModes.map((m) => m.id)).toEqual([
        'default',
        'plan',
        'auto',
        'yolo',
      ]);
    },
    30_000,
  );

  it(
    'session/set_mode pushes current_mode_update alongside config_option_update',
    async () => {
      await boot();
      const { sessionId } = await newSession();
      const modeUpdatePromise = client!.waitForSessionUpdate('current_mode_update');
      const configUpdatePromise = client!.waitForSessionUpdate('config_option_update');
      await client!.send('session/set_mode', { sessionId, modeId: 'yolo' });

      const modeNotification = await modeUpdatePromise;
      const modeUpdate = (modeNotification.params as { update?: { currentModeId?: string } })
        .update;
      expect(modeUpdate?.currentModeId).toBe('yolo');

      // The configOptions arm still refreshes for config-option clients.
      const configNotification = await configUpdatePromise;
      const configUpdate = (
        configNotification.params as { update?: { configOptions?: readonly ConfigOption[] } }
      ).update;
      expect(configUpdate?.configOptions?.find((o) => o.id === 'mode')?.currentValue).toBe('yolo');
    },
    30_000,
  );

  it(
    'session/set_config_option mode also pushes current_mode_update',
    async () => {
      await boot();
      const { sessionId } = await newSession();
      const modeUpdatePromise = client!.waitForSessionUpdate('current_mode_update');
      await client!.send('session/set_config_option', {
        sessionId,
        configId: 'mode',
        value: 'plan',
      });
      const modeNotification = await modeUpdatePromise;
      const modeUpdate = (modeNotification.params as { update?: { currentModeId?: string } })
        .update;
      expect(modeUpdate?.currentModeId).toBe('plan');
    },
    30_000,
  );

  it(
    'session/set_config_option mode updates the returned snapshot',
    async () => {
      await boot();
      const { sessionId } = await newSession();
      const result = (await client!.send('session/set_config_option', {
        sessionId,
        configId: 'mode',
        value: 'yolo',
      })) as { configOptions: readonly ConfigOption[] };
      const mode = result.configOptions.find((o) => o.id === 'mode')!;
      expect(mode.currentValue).toBe('yolo');
    },
    30_000,
  );

  it(
    'session/set_config_option rejects an unknown modeId',
    async () => {
      await boot();
      const { sessionId } = await newSession();
      await expect(
        client!.send('session/set_config_option', {
          sessionId,
          configId: 'mode',
          value: 'bogus',
        }),
      ).rejects.toThrow();
    },
    30_000,
  );

  it(
    'session/set_config_option rejects an unknown configId',
    async () => {
      await boot();
      const { sessionId } = await newSession();
      await expect(
        client!.send('session/set_config_option', {
          sessionId,
          configId: 'nope',
          value: 'x',
        }),
      ).rejects.toThrow();
    },
    30_000,
  );

  it(
    'session/set_model switches the model and pushes config_option_update',
    async () => {
      await boot({ fakeModel: true });
      const { sessionId } = await newSession();
      // `session/set_model` was dropped from the SDK's legacy Agent interface
      // in 1.x; the server keeps it as an extMethod special-case.
      const updatePromise = client!.waitForSessionUpdate('config_option_update');
      const result = await client!.send('session/set_model', {
        sessionId,
        modelId: FAKE_MODEL_ALT_ID,
      });
      expect(result).toEqual({});
      // The switch reached the engine, not just the ACP surface.
      await expect(
        client!.server.klient.session(sessionId).agent('main').getModel(),
      ).resolves.toBe(FAKE_MODEL_ALT_ID);
      const notification = await updatePromise;
      const update = (
        notification.params as { update?: { configOptions?: readonly ConfigOption[] } }
      ).update;
      const model = update?.configOptions?.find((o) => o.id === 'model');
      expect(model?.currentValue).toBe(FAKE_MODEL_ALT_ID);
    },
    30_000,
  );

  it(
    'session/set_model rejects malformed params',
    async () => {
      await boot({ fakeModel: true });
      const { sessionId } = await newSession();
      await expect(
        client!.send('session/set_model', { sessionId, modelId: 42 }),
      ).rejects.toThrow();
      await expect(
        client!.send('session/set_model', { sessionId: 'nope', modelId: FAKE_MODEL_ALT_ID }),
      ).rejects.toThrow();
    },
    30_000,
  );

  it(
    'the merged "<id>,thinking" form sets the bare model and flips thinking on at its default effort',
    async () => {
      await boot({
        fakeModel: true,
        altThinking: true,
        altSupportEfforts: ['low', 'high'],
        altDefaultEffort: 'high',
      });
      const { sessionId } = await newSession();
      const agent = client!.server.klient.session(sessionId).agent('main');

      const result = await client!.send('session/set_model', {
        sessionId,
        modelId: `${FAKE_MODEL_ALT_ID},thinking`,
      });
      expect(result).toEqual({});
      // The bare id reached the engine; thinking flipped on at the NEW
      // model's declared default effort.
      await expect(agent.getModel()).resolves.toBe(FAKE_MODEL_ALT_ID);
      await expect(agent.getThinking()).resolves.toBe('high');

      // The picker snapshot never carries the `,thinking` suffix.
      const listed = (await client!.send('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: `${FAKE_MODEL_ALT_ID},thinking`,
      })) as { configOptions: readonly ConfigOption[] };
      expect(listed.configOptions.find((o) => o.id === 'model')?.currentValue).toBe(
        FAKE_MODEL_ALT_ID,
      );
      await expect(agent.getModel()).resolves.toBe(FAKE_MODEL_ALT_ID);
      await expect(agent.getThinking()).resolves.toBe('high');
    },
    30_000,
  );

  it(
    'a bare set_model id does not turn thinking off',
    async () => {
      await boot({ fakeModel: true, thinking: true, altThinking: true });
      const { sessionId } = await newSession();
      const agent = client!.server.klient.session(sessionId).agent('main');
      // The default model is thinking-capable → thinking starts on.
      await expect(agent.getThinking()).resolves.not.toBe('off');

      await client!.send('session/set_model', { sessionId, modelId: FAKE_MODEL_ALT_ID });
      await expect(agent.getModel()).resolves.toBe(FAKE_MODEL_ALT_ID);
      // Model and thinking stay orthogonal: the requested level survives the
      // switch (the engine re-resolves it against the new thinking-capable
      // model — it must not land on 'off').
      await expect(agent.getThinking()).resolves.not.toBe('off');
    },
    30_000,
  );

  it(
    'session/new advertises the thinking toggle for a thinking-capable model',
    async () => {
      await boot({ fakeModel: true, thinking: true });
      const { configOptions } = await newSession();
      const thinking = configOptions.find((o) => o.id === 'thinking');
      // A thinking-capable model defaults to thinking on (the engine resolves
      // the model's default effort when nothing is configured).
      expect(thinking?.currentValue).toBe('on');
    },
    30_000,
  );

  it(
    'session/new omits the thinking toggle for a non-thinking model',
    async () => {
      await boot({ fakeModel: true });
      const { configOptions } = await newSession();
      expect(configOptions.map((o) => o.id)).not.toContain('thinking');
    },
    30_000,
  );

  it(
    'session/set_config_option thinking takes effect and pushes config_option_update',
    async () => {
      await boot({ fakeModel: true, thinking: true });
      const { sessionId } = await newSession();
      const updatePromise = client!.waitForSessionUpdate('config_option_update');
      const result = (await client!.send('session/set_config_option', {
        sessionId,
        configId: 'thinking',
        value: 'off',
      })) as { configOptions: readonly ConfigOption[] };
      expect(result.configOptions.find((o) => o.id === 'thinking')?.currentValue).toBe('off');
      // The toggle reached the engine, not just the ACP surface.
      await expect(
        client!.server.klient.session(sessionId).agent('main').getThinking(),
      ).resolves.toBe('off');
      const notification = await updatePromise;
      const update = (
        notification.params as { update?: { configOptions?: readonly ConfigOption[] } }
      ).update;
      expect(update?.configOptions?.find((o) => o.id === 'thinking')?.currentValue).toBe('off');
    },
    30_000,
  );

  it(
    'session/set_config_option rejects an unknown thinking value',
    async () => {
      await boot({ fakeModel: true, thinking: true });
      const { sessionId } = await newSession();
      await expect(
        client!.send('session/set_config_option', {
          sessionId,
          configId: 'thinking',
          value: 'bogus',
        }),
      ).rejects.toThrow();
    },
    30_000,
  );

  it(
    'an effort-capable model advertises off + every declared effort',
    async () => {
      await boot({
        fakeModel: true,
        thinking: true,
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      });
      const { configOptions } = await newSession();
      const thinking = configOptions.find((o) => o.id === 'thinking');
      expect(thinking?.options?.map((o) => o.value)).toEqual(['off', 'low', 'high']);
      // Nothing configured → the engine resolves the model's default effort.
      expect(thinking?.currentValue).toBe('high');
    },
    30_000,
  );

  it(
    'setting a declared effort level takes effect and pushes config_option_update',
    async () => {
      await boot({
        fakeModel: true,
        thinking: true,
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      });
      const { sessionId } = await newSession();
      const updatePromise = client!.waitForSessionUpdate('config_option_update');
      const result = (await client!.send('session/set_config_option', {
        sessionId,
        configId: 'thinking',
        value: 'low',
      })) as { configOptions: readonly ConfigOption[] };
      expect(result.configOptions.find((o) => o.id === 'thinking')?.currentValue).toBe('low');
      // The level reached the engine, not just the ACP surface.
      await expect(
        client!.server.klient.session(sessionId).agent('main').getThinking(),
      ).resolves.toBe('low');
      const notification = await updatePromise;
      const update = (
        notification.params as { update?: { configOptions?: readonly ConfigOption[] } }
      ).update;
      expect(update?.configOptions?.find((o) => o.id === 'thinking')?.currentValue).toBe('low');
    },
    30_000,
  );

  it(
    "an effort-capable model maps the legacy 'on' to its default effort",
    async () => {
      await boot({
        fakeModel: true,
        thinking: true,
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      });
      const { sessionId } = await newSession();
      const result = (await client!.send('session/set_config_option', {
        sessionId,
        configId: 'thinking',
        value: 'on',
      })) as { configOptions: readonly ConfigOption[] };
      expect(result.configOptions.find((o) => o.id === 'thinking')?.currentValue).toBe('high');
      await expect(
        client!.server.klient.session(sessionId).agent('main').getThinking(),
      ).resolves.toBe('high');
    },
    30_000,
  );

  it(
    'an effort-capable model rejects an undeclared effort with invalid_params',
    async () => {
      await boot({
        fakeModel: true,
        thinking: true,
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      });
      const { sessionId } = await newSession();
      await expect(
        client!.send('session/set_config_option', {
          sessionId,
          configId: 'thinking',
          value: 'banana',
        }),
      ).rejects.toThrow(/-32602/);
    },
    30_000,
  );

  it(
    'a Claude model on an Anthropic-typed provider advertises the thinking toggle via engine-derived capabilities',
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'acp-config-'));
      // No declared capabilities: the engine's catalog (`effectiveModelConfig`
      // with the provider type) infers the Anthropic thinking profile for the
      // Claude wire name, so the wire `capabilities`/`support_efforts` the ACP
      // host reads already carry the derivation.
      await writeFile(
        join(homeDir, 'config.toml'),
        `defaultModel = "claude"

[providers.anthro]
type = "anthropic"
baseUrl = "http://localhost"
apiKey = "test-token"

[models.claude]
provider = "anthro"
name = "claude-sonnet-4-5"
maxContextSize = 200000
`,
        'utf8',
      );
      client = await createTestClient({ homeDir });
      await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const { configOptions } = await newSession();
      const thinking = configOptions.find((o) => o.id === 'thinking');
      expect(thinking).toBeDefined();
      // The inferred profile is effort-granular, not a bare off/on toggle.
      expect(thinking?.options?.length).toBeGreaterThan(2);
      expect(thinking?.options?.some((o) => o.value === 'off')).toBe(true);
    },
    30_000,
  );

  it(
    'a $/cancel_request notification is accepted without error',
    async () => {
      await boot();
      await newSession();
      // The SDK handles the JSON-RPC-level cancel notification internally; a
      // stray one (unknown id) must be a no-op, not a connection error.
      client!.notify('$/cancel_request', { id: 999_999 });
      const list = (await client!.send('session/list', {})) as { sessions: unknown[] };
      expect(list.sessions.length).toBeGreaterThan(0);
    },
    30_000,
  );
});
