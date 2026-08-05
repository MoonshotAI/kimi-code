/**
 * G4 service group tests — flagService + modelService + providerService +
 * modelResolver (incl. streaming generate) + providerDiscovery over a
 * host-side config (smol-toml). The channel is built directly (not through
 * `createKlientFromRust`, whose registry hub imports not-yet-landed group
 * modules), so these tests exercise the service tables + facade contract
 * validation without spawning the Rust engine.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import * as rustLoop from '@moonshot-ai/kimi-agent/rust-loop';
import { describe, expect, it } from 'vitest';

import { createKlientFromChannel } from '#/core/klient';
import { RustChannel } from '#/transports/rust/channel';
// Self-registers flagService/modelService/modelResolver/providerService/providerDiscovery.
import '#/transports/rust/services/flagsCatalog';
import type { RustHostServices } from '#/transports/rust/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

const SEED_CONFIG = `default_model = "kimi/kimi-for-coding"

[experimental]
fault-injection = true

[providers.openai]
type = "openai"
api_key = "sk-test-123"

[providers.anthropic]
type = "anthropic"

[providers.staticprov]
type = "openai"
model_source = "static"

[models."kimi/kimi-for-coding"]
provider = "kimi"
model = "kimi-for-coding"
max_context_size = 131072
capabilities = ["tool_use"]

[models."openai/gpt-4o-mini"]
provider = "openai"
model = "gpt-4o-mini"
max_context_size = 128000
`;

interface TestSetup {
  readonly home: string;
  readonly configPath: string;
  readonly klient: ReturnType<typeof createKlientFromChannel>;
  close(): Promise<void>;
}

function setupKlient(seed = SEED_CONFIG): TestSetup {
  const home = mkdtempSync(join(tmpdir(), 'klient-g4-'));
  const configPath = join(home, 'config.toml');
  writeFileSync(configPath, seed);
  const host: RustHostServices = { homeDir: home, configPath };
  const channel = new RustChannel({ rust: rustLoop as typeof rustLoop, host });
  const klient = createKlientFromChannel(channel, {});
  return {
    home,
    configPath,
    klient,
    close: async () => {
      await klient.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function withEnv(key: string, value: string, run: () => Promise<void> | void): Promise<void> {
  const previous = process.env[key];
  process.env[key] = value;
  const restore = (): void => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  };
  return Promise.resolve()
    .then(run)
    .then(restore, (error) => {
      restore();
      throw error;
    });
}

// ── flagService ─────────────────────────────────────────────────────────────

describe('flagService', () => {
  it('resolves flags from the [experimental] config section and defaults', async () => {
    const setup = setupKlient();
    try {
      // fault-injection is enabled via [experimental]; tool-select falls back.
      await expect(setup.klient.global.flags.enabled('fault-injection')).resolves.toBe(true);
      await expect(setup.klient.global.flags.enabled('tool-select')).resolves.toBe(false);

      const explained = await setup.klient.global.flags.explain('fault-injection');
      expect(explained).toMatchObject({
        id: 'fault-injection',
        env: 'KIMI_CODE_EXPERIMENTAL_FAULT_INJECTION',
        defaultEnabled: false,
        enabled: true,
        source: 'config',
        configValue: true,
        surface: 'core',
      });

      const toolSelect = await setup.klient.global.flags.explain('tool-select');
      expect(toolSelect).toMatchObject({ enabled: false, source: 'default' });
      expect(toolSelect?.configValue).toBeUndefined();

      // Unknown flag ids resolve to undefined / false without throwing.
      await expect(setup.klient.global.flags.explain('no-such-flag')).resolves.toBeUndefined();
      await expect(setup.klient.global.flags.enabled('no-such-flag')).resolves.toBe(false);

      await expect(setup.klient.global.flags.snapshot()).resolves.toEqual({
        'fault-injection': true,
        'persistence_minidb_readmodel': false,
        'secondary-model': false,
        'tool-select': false,
      });
      await expect(setup.klient.global.flags.enabledIds()).resolves.toEqual(['fault-injection']);
      await expect(setup.klient.global.flags.list()).resolves.toHaveLength(4);
    } finally {
      await setup.close();
    }
  });

  it('honors the per-flag env var over the config value', async () => {
    const setup = setupKlient();
    try {
      await withEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', '1', async () => {
        await expect(setup.klient.global.flags.enabled('tool-select')).resolves.toBe(true);
        const explained = await setup.klient.global.flags.explain('tool-select');
        expect(explained?.source).toBe('env');
      });
      // Restored: back to the config/default answer.
      await expect(setup.klient.global.flags.enabled('tool-select')).resolves.toBe(false);
    } finally {
      await setup.close();
    }
  });

  it('enables every flag through the master env var', async () => {
    const setup = setupKlient();
    try {
      await withEnv('KIMI_CODE_EXPERIMENTAL_FLAG', 'true', async () => {
        await expect(setup.klient.global.flags.enabledIds()).resolves.toEqual([
          'fault-injection',
          'tool-select',
          'persistence_minidb_readmodel',
          'secondary-model',
        ]);
        const explained = await setup.klient.global.flags.explain('secondary-model');
        expect(explained?.source).toBe('master-env');
        expect(explained?.enabled).toBe(true);
      });
    } finally {
      await setup.close();
    }
  });
});

// ── modelService ────────────────────────────────────────────────────────────

describe('modelService', () => {
  it('lists seeded models and gets one (snake_case keys normalized)', async () => {
    const setup = setupKlient();
    try {
      const listed = await setup.klient.global.kosong.listModels();
      expect(listed.map((item) => item.model).sort()).toEqual([
        'kimi/kimi-for-coding',
        'openai/gpt-4o-mini',
      ]);
      const kimi = listed.find((item) => item.model === 'kimi/kimi-for-coding');
      expect(kimi).toMatchObject({
        provider: 'kimi',
        display_name: 'kimi-for-coding',
        max_context_size: 131072,
        capabilities: ['tool_use'],
      });
    } finally {
      await setup.close();
    }
  });

  it('round-trips set/delete through the facade, including flat models', async () => {
    const setup = setupKlient();
    try {
      // Anonymous provider → modelService.set with a flat record (no provider).
      await setup.klient.global.kosong.addProvider({
        id: 'anon/x',
        model: 'x',
        protocol: 'openai',
        baseUrl: 'http://localhost:9/v1',
        auth: { method: 'api-key', apiKey: 'sk-anon' },
        maxContextSize: 4096,
      });

      const all = await setup.klient.global.kosong.listModels();
      expect(all.find((item) => item.model === 'anon/x')).toMatchObject({
        model: 'anon/x',
        display_name: 'x',
        max_context_size: 4096,
      });

      // removeProvider falls back to modelService.delete when no provider exists.
      await setup.klient.global.kosong.removeProvider('anon/x');
      const after = await setup.klient.global.kosong.listModels();
      expect(after.find((item) => item.model === 'anon/x')).toBeUndefined();

      // The write persisted to config.toml, and the delete removed the entry.
      const onDisk = readFileSync(setup.configPath, 'utf-8');
      expect(onDisk).not.toContain('anon/x');
    } finally {
      await setup.close();
    }
  });
});

// ── providerService ─────────────────────────────────────────────────────────

describe('providerService', () => {
  it('gets a seeded provider and round-trips set/delete', async () => {
    const setup = setupKlient();
    try {
      await setup.klient.global.kosong.addProvider('my-provider', {
        type: 'openai',
        baseUrl: 'http://localhost:9/v1',
        auth: { method: 'api-key', apiKey: 'sk-abc' },
      });

      const providers = await setup.klient.global.kosong.listProviders();
      expect(providers.find((p) => p.id === 'my-provider')).toMatchObject({
        id: 'my-provider',
        type: 'openai',
        has_api_key: true,
        status: 'connected',
        base_url: 'http://localhost:9/v1',
      });

      await setup.klient.global.kosong.removeProvider('my-provider');
      const after = await setup.klient.global.kosong.listProviders();
      expect(after.find((p) => p.id === 'my-provider')).toBeUndefined();
    } finally {
      await setup.close();
    }
  });
});

// ── modelResolver ───────────────────────────────────────────────────────────

describe('modelResolver', () => {
  it('lists providers with credential state and bound models', async () => {
    const setup = setupKlient();
    try {
      const providers = await setup.klient.global.kosong.listProviders();
      const openai = providers.find((p) => p.id === 'openai');
      expect(openai).toMatchObject({
        id: 'openai',
        type: 'openai',
        has_api_key: true,
        status: 'connected',
        models: ['openai/gpt-4o-mini'],
      });
      const anthropic = providers.find((p) => p.id === 'anthropic');
      expect(anthropic).toMatchObject({ id: 'anthropic', has_api_key: false, status: 'unconfigured' });
    } finally {
      await setup.close();
    }
  });

  it('getProvider returns one provider and rejects for unknown ids', async () => {
    const setup = setupKlient();
    try {
      const provider = await setup.klient.global.kosong.getProvider('openai');
      expect(provider.id).toBe('openai');
      await expect(setup.klient.global.kosong.getProvider('no-such-provider')).rejects.toThrow(
        /no-such-provider/,
      );
    } finally {
      await setup.close();
    }
  });

  it('setDefaultModel writes the pointer and rejects for unknown models', async () => {
    const setup = setupKlient();
    try {
      const result = await setup.klient.global.kosong.setDefaultModel('openai/gpt-4o-mini');
      expect(result.default_model).toBe('openai/gpt-4o-mini');
      expect(result.model).toMatchObject({ provider: 'openai', model: 'openai/gpt-4o-mini' });

      const providers = await setup.klient.global.kosong.listProviders();
      expect(providers.find((p) => p.id === 'openai')?.default_model).toBe('openai/gpt-4o-mini');

      await expect(setup.klient.global.kosong.setDefaultModel('no-such-model')).rejects.toThrow(
        /no-such-model/,
      );
    } finally {
      await setup.close();
    }
  });
});

// ── providerDiscovery ───────────────────────────────────────────────────────

describe('providerDiscovery', () => {
  it('rejects an unknown provider id', async () => {
    const setup = setupKlient();
    try {
      await expect(
        setup.klient.global.kosong.refreshProviders({ providerId: 'no-such-provider' }),
      ).rejects.toThrow(/no-such-provider/);
    } finally {
      await setup.close();
    }
  });

  it('short-circuits statically-sourced providers without network I/O', async () => {
    const setup = setupKlient();
    try {
      const result = await setup.klient.global.kosong.refreshProviders({ providerId: 'staticprov' });
      expect(result).toEqual({ changed: [], unchanged: ['staticprov'], failed: [] });
    } finally {
      await setup.close();
    }
  });
});

// ── modelResolver.generate (streaming) ──────────────────────────────────────

/** Minimal OpenAI-compatible SSE chat-completions endpoint. */
function startSseServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !(req.url?.includes('/chat/completions') ?? false)) {
      res.writeHead(404);
      res.end();
      return;
    }
    req.resume(); // drain the request body
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const chunks = [
      {
        id: 'chatcmpl-test-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-test',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-test-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-test',
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-test-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-test',
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-test-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-test',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      {
        id: 'chatcmpl-test-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ];
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

describe('modelResolver.generate', () => {
  it('streams part/usage/finish events from an OpenAI-compatible endpoint', async () => {
    const server = await startSseServer();
    const setup = setupKlient();
    try {
      await setup.klient.global.kosong.addProvider({
        id: 'test/openai',
        model: 'gpt-test',
        protocol: 'openai',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        auth: { method: 'api-key', apiKey: 'test-key' },
        maxContextSize: 8192,
      });

      const events: Array<{ type: string; [key: string]: unknown }> = [];
      for await (const event of setup.klient.global.kosong.generate(
        'test/openai',
        {
          systemPrompt: 'You are terse.',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
        },
        { maxCompletionTokens: 64 },
      )) {
        events.push(event as { type: string; [key: string]: unknown });
      }

      const types = events.map((event) => event.type);
      expect(types).toContain('part');
      expect(types).toContain('finish');

      const textParts = events
        .filter((event) => event.type === 'part')
        .flatMap((event) => {
          const part = event['part'] as { type?: string; text?: string };
          return part.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
        });
      expect(textParts.join('')).toContain('Hello world');

      const finish = events.find((event) => event.type === 'finish');
      expect(finish).toBeDefined();
      expect((finish?.['message'] as { role?: string }).role).toBe('assistant');

      // Streaming an unknown model id fails the stream.
      await expect(async () => {
        for await (const _event of setup.klient.global.kosong.generate('no-such-model', {
          systemPrompt: 'x',
          messages: [],
        })) {
          // no-op
        }
      }).rejects.toThrow(/no-such-model/);
    } finally {
      await setup.close();
      await server.close();
    }
  });
});
