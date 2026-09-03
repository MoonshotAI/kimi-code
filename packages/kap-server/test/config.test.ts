import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigChanged,
  IConfigService,
  IEventService,
  type ConfigSectionChangedEvent,
  type Event2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { configResponseSchema, type ConfigResponse } from '../src/protocol/rest-config';
import { ErrorCode } from '../src/protocol/error-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { startConfigChangedPublisher } from '../src/services/config/configChangedPublisher';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch, bearerToken } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 /api/v1/config', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-config-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getConfig(): Promise<ConfigResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ConfigResponse>;
    expect(body.code).toBe(0);
    return configResponseSchema.parse(body.data);
  }

  async function patchConfig(patch: Record<string, unknown>): Promise<ConfigResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ConfigResponse>;
    expect(body.code).toBe(0);
    return configResponseSchema.parse(body.data);
  }

  it('GET echoes default_permission_mode and derives yolo = false', async () => {
    await boot('default_permission_mode = "auto"\n');
    const cfg = await getConfig();
    expect(cfg.default_permission_mode).toBe('auto');
    expect(cfg.yolo).toBe(false);
  });

  it('POST { yolo: true } sets default_permission_mode = yolo and echoes yolo = true', async () => {
    await boot();
    const cfg = await patchConfig({ yolo: true });
    expect(cfg.default_permission_mode).toBe('yolo');
    expect(cfg.yolo).toBe(true);

    const after = await getConfig();
    expect(after.default_permission_mode).toBe('yolo');
    expect(after.yolo).toBe(true);
  });

  it('POST { default_permission_mode: auto } writes the canonical field and derives yolo = false', async () => {
    await boot();
    const cfg = await patchConfig({ default_permission_mode: 'auto' });
    expect(cfg.default_permission_mode).toBe('auto');
    expect(cfg.yolo).toBe(false);

    const after = await getConfig();
    expect(after.default_permission_mode).toBe('auto');
    expect(after.yolo).toBe(false);
  });

  it('POST { secondary_model } persists the subagent model pool and GET echoes it', async () => {
    await boot();
    const cfg = await patchConfig({
      secondary_model: {
        default_model: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap' },
      },
    });
    expect(cfg.secondary_model).toMatchObject({ defaultModel: 'provider/fast' });

    const after = await getConfig();
    expect(after.secondary_model).toMatchObject({
      defaultModel: 'provider/fast',
      models: { 'provider/fast': 'fast and cheap' },
    });
  });

  it('POST { secondary_model } preserves pool alias keys containing underscores', async () => {
    await boot();
    await patchConfig({
      secondary_model: { default_model: 'provider/fast_model', models: { 'provider/fast_model': '' } },
    });

    const after = await getConfig();
    expect(after.secondary_model).toMatchObject({
      defaultModel: 'provider/fast_model',
      models: { 'provider/fast_model': '' },
    });
    expect(
      Object.keys((after.secondary_model as { models: Record<string, string> }).models),
    ).not.toContain('provider/fastModel');
  });

  it('POST { providers } converts fields of a provider id colliding with a map-valued key', async () => {
    await boot();
    await patchConfig({
      providers: {
        models: { type: 'openai', base_url: 'https://example.test', api_key: 'sk-test' },
      },
    });

    const after = await getConfig();
    expect(after.providers['models']).toMatchObject({
      type: 'openai',
      base_url: 'https://example.test',
      has_api_key: true,
    });
  });

  it('session create with a broken subagent model pool still succeeds', async () => {
    await boot('[secondary_model.models]\n"provider/fast" = "fast and cheap"\n');
    const res = await authedFetch(server as RunningServer, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    });
    const body = (await res.json()) as Envelope<{ id?: string }>;
    expect(body.code).toBe(0);
    expect(body.data?.id).toBeTruthy();
  });
});

describe('server-v2 config changed WS notifications', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-config-ws-'));
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  interface ConfigChangedFrame {
    type: 'event.config.changed';
    payload: {
      changedFields: string[];
      config: Record<string, unknown>;
    };
  }

  async function openWs(): Promise<ConfigChangedFrame[]> {
    const live = server as RunningServer;
    const ws = new WebSocket(`ws://127.0.0.1:${live.port}/api/v1/ws`, [
      `kimi-code.bearer.${bearerToken(live)}`,
    ]);
    sockets.push(ws);
    const frames: ConfigChangedFrame[] = [];
    ws.on('message', (data) => {
      const frame = JSON.parse((data as Buffer).toString()) as { type?: string };
      if (frame.type === 'event.config.changed') frames.push(frame as ConfigChangedFrame);
    });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'client_hello', payload: { client_id: 'config-ws-test' } }));
    return frames;
  }

  async function patchConfig(patch: Record<string, unknown>): Promise<void> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<unknown>;
    expect(body.code).toBe(0);
  }

  it('publishes a trailing event with camelCase changedFields and the full snapshot after POST /config', async () => {
    await boot('default_permission_mode = "auto"\n');
    const frames = await openWs();

    await patchConfig({ yolo: true });

    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1));
    const last = frames.at(-1) as ConfigChangedFrame;
    expect(last.payload.changedFields).toEqual(['defaultPermissionMode']);
    expect(last.payload.config['default_permission_mode']).toBe('yolo');
    expect(last.payload.config['yolo']).toBe(true);
    expect(last.payload.config).toHaveProperty('providers');
  });

  it('publishes camelCase changedFields on the engine write path used by OAuth refreshes', async () => {
    await boot();
    const frames = await openWs();

    const config = (server as RunningServer).core.accessor.get(IConfigService);
    await config.ready;
    await config.replace('defaultModel', 'k2');

    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1));
    const last = frames.at(-1) as ConfigChangedFrame;
    expect(last.payload.changedFields).toEqual(['defaultModel']);
    expect(last.payload.config['default_model']).toBe('k2');
  });

  it('publishes an event when config.toml is edited outside the process and reloaded', async () => {
    await boot('default_permission_mode = "auto"\n');
    const frames = await openWs();

    await writeFile(
      join(home as string, 'config.toml'),
      'default_permission_mode = "yolo"\n',
      'utf-8',
    );
    const config = (server as RunningServer).core.accessor.get(IConfigService);
    await config.ready;
    await config.reload();

    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    const last = frames.at(-1) as ConfigChangedFrame;
    expect(last.payload.changedFields).toContain('defaultPermissionMode');
    expect(last.payload.config['default_permission_mode']).toBe('yolo');
  });

  it('closes the config publisher before the app, so a pending change is never delivered during shutdown', async () => {
    await boot();
    const published: string[] = [];
    const events = (server as RunningServer).core.accessor.get(IEventService);
    const subscription = events.subscribe((event) => {
      if (event.type === 'event.config.changed') published.push(event.type);
    });

    const config = (server as RunningServer).core.accessor.get(IConfigService);
    await config.ready;
    await config.replace('defaultModel', 'k2');
    for (const ws of sockets.splice(0)) ws.close();
    const live = server as RunningServer;
    server = undefined;
    await live.close();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(published).toHaveLength(0);
    subscription.dispose();
  });
});

describe('configChangedPublisher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const listeners = new Set<(event: ConfigSectionChangedEvent) => void>();
    let backing: Record<string, unknown> = {};
    const published: ConfigChanged[] = [];
    let disposed = false;
    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === IConfigService) {
            return {
              onDidSectionChange: (listener: (event: ConfigSectionChangedEvent) => void) => {
                listeners.add(listener);
                return {
                  dispose: () => {
                    disposed = true;
                    listeners.delete(listener);
                  },
                };
              },
              getAll: () => backing,
            };
          }
          return {
            publish: (event: Event2<unknown>) => published.push(event as ConfigChanged),
          };
        },
      },
    } as unknown as Scope;
    const publisher = startConfigChangedPublisher(core);
    const fire = (domain: string): void => {
      for (const listener of listeners) {
        listener({ domain, source: 'set', value: undefined, previousValue: undefined });
      }
    };
    return {
      publisher,
      published,
      fire,
      isDisposed: () => disposed,
      setBacking: (value: Record<string, unknown>) => {
        backing = value;
      },
    };
  }

  it('merges section events inside one flush window into a single ConfigChanged', () => {
    vi.useFakeTimers();
    const { published, fire } = setup();

    fire('defaultPermissionMode');
    fire('defaultModel');
    vi.advanceTimersByTime(50);

    expect(published).toHaveLength(1);
    expect(published[0]?.payload.changedFields).toEqual(['defaultModel', 'defaultPermissionMode']);
  });

  it('projects the full config snapshot at flush time', () => {
    vi.useFakeTimers();
    const { published, fire, setBacking } = setup();

    fire('defaultModel');
    setBacking({ defaultModel: 'k2', providers: {} });
    vi.advanceTimersByTime(50);

    expect(published).toHaveLength(1);
    expect(published[0]?.payload.config).toEqual({ default_model: 'k2', providers: {} });
  });

  it('redacts inline model credentials from the published config projection', () => {
    vi.useFakeTimers();
    const { published, fire, setBacking } = setup();
    setBacking({
      providers: {},
      models: {
        'p/m': { provider: 'p', model: 'm', maxContextSize: 4096, apiKey: 'sk-secret' },
        'p/flat': { baseUrl: 'https://x.test', model: 'm', oauth: { storage: 'file', key: 'oauth/x' } },
      },
    });

    fire('models');
    vi.advanceTimersByTime(50);

    expect(published).toHaveLength(1);
    const config = published[0]?.payload.config as Record<string, unknown>;
    const models = config['models'] as Record<string, Record<string, unknown>>;
    expect(models['p/m']).toEqual({ provider: 'p', model: 'm', maxContextSize: 4096, has_api_key: true });
    expect(models['p/flat']).toEqual({ baseUrl: 'https://x.test', model: 'm', has_api_key: true });
    expect(JSON.stringify(models)).not.toContain('sk-secret');
  });

  it('redacts inline service credentials from the published config projection', () => {
    vi.useFakeTimers();
    const { published, fire, setBacking } = setup();
    setBacking({
      providers: {},
      services: {
        moonshotSearch: {
          baseUrl: 'https://s.test',
          apiKey: 'sk-svc',
          customHeaders: { Authorization: 'Bearer abc', 'x-team': 'core' },
        },
      },
    });

    fire('services');
    vi.advanceTimersByTime(50);

    expect(published).toHaveLength(1);
    const config = published[0]?.payload.config as Record<string, unknown>;
    const services = config['services'] as Record<string, Record<string, unknown>>;
    expect(services['moonshotSearch']).toEqual({
      baseUrl: 'https://s.test',
      has_api_key: true,
      custom_header_keys: ['Authorization', 'x-team'],
    });
    expect(JSON.stringify(services)).not.toContain('sk-svc');
    expect(JSON.stringify(services)).not.toContain('Bearer abc');
  });

  it('always delivers a trailing event for late-arriving changes', () => {
    vi.useFakeTimers();
    const { published, fire } = setup();

    fire('defaultPermissionMode');
    vi.advanceTimersByTime(12);
    fire('models');
    vi.advanceTimersByTime(12);

    expect(published).toHaveLength(2);
    expect(published[1]?.payload.changedFields).toEqual(['models']);
  });

  it('drops pending changes on close and never publishes afterwards', () => {
    vi.useFakeTimers();
    const { published, publisher, fire, isDisposed } = setup();

    fire('defaultModel');
    publisher.close();
    vi.advanceTimersByTime(50);
    fire('models');
    vi.advanceTimersByTime(50);

    expect(published).toHaveLength(0);
    expect(isDisposed()).toBe(true);
  });
});
