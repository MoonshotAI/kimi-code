/**
 * Shared conformance suite — the guarantee that the ipc and memory
 * transports are interchangeable. Every transport test file runs the exact
 * same assertions against a real in-process engine; only the `before` setup
 * differs per file.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Service } from '@moonshot-ai/agent-core-v2/_base/di/service';
import { CommandContribution } from '@moonshot-ai/agent-core-v2/agent/command/commandContribution';
import { ToolResultEvent } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import { IEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import { IFeatureManager } from '@moonshot-ai/agent-core-v2/app/feature/featureManager';
import { getLiveSessionById } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionLookup';
import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { IModelCatalog } from '@moonshot-ai/agent-core-v2/llm-adapter/model/catalog';
import { IModelService } from '@moonshot-ai/agent-core-v2/llm-adapter/model/model';
import { IProtocolAdapterRegistry } from '@moonshot-ai/agent-core-v2/llm-adapter/protocol/protocol';
import { generateModel } from '@moonshot-ai/agent-core-v2/llm-adapter/model/generate';
import type { LlmRequester } from '@moonshot-ai/agent-core-v2/human/llm-requester/requester';
import { coreRequesterFromA } from '../../../agent-core-v2/test/harness/scripted-generate.js';
import {
  resetModelsDevUpstreamForTest,
  setModelsDevUpstreamForTest,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/modelsDevUpstream';

import type { Klient } from '../../src/index.js';
import type { TestEngine } from './engine.js';

export interface KlientConformanceTarget {
  readonly klient: Klient;
  /**
   * The in-process engine's App scope. Both transports boot the engine
   * in-process, so the suite can assemble dynamic units (e.g. contributed
   * commands) through the production `IFeatureManager` path.
   */
  readonly app: TestEngine['app'];
  cleanup(): Promise<void>;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export function defineKlientConformance(
  transport: string,
  makeTarget: () => Promise<KlientConformanceTarget>,
): void {
  describe(`klient conformance: ${transport}`, () => {
    let target: KlientConformanceTarget;

    beforeAll(async () => {
      target = await makeTarget();
    });

    afterAll(async () => {
      await target.cleanup();
    });

    it('env() aggregates the host snapshot', async () => {
      const env = await target.klient.global.env();
      expect(env.platform).toBe(process.platform);
      expect(env.homeDir.length).toBeGreaterThan(0);
      expect(env.clientVersion.length).toBeGreaterThan(0);
    });

    it('workspaces round-trip through create/get/update/list/delete', async () => {
      const additionalDir = await mkdtemp(join(tmpdir(), 'klient-workspace-extra-'));
      try {
        const workspaces = target.klient.global.workspaces;
        const created = await workspaces.createOrTouch({ root: process.cwd(), name: 'conformance' });
        expect(created.id.length).toBeGreaterThan(0);

        const fetched = await workspaces.get(created.id);
        expect(fetched?.name).toBe('conformance');

        const updated = await workspaces.update({ id: created.id, patch: { name: 'conformance-2' } });
        expect(updated?.name).toBe('conformance-2');

        const withAdditionalDirs = await workspaces.update({
          id: created.id,
          patch: { additionalDirs: [additionalDir] },
        });
        expect(withAdditionalDirs?.additionalDirs).toEqual([additionalDir]);

        const cleared = await workspaces.update({
          id: created.id,
          patch: { additionalDirs: [] },
        });
        expect(cleared?.additionalDirs).toEqual([]);

        const list = await workspaces.list();
        expect(list.some((w) => w.id === created.id)).toBe(true);

        await workspaces.delete(created.id);
        expect(await workspaces.get(created.id)).toBeUndefined();
      } finally {
        await rm(additionalDir, { recursive: true, force: true });
      }
    });

    it('sessions index responds with a page shape', async () => {
      const page = await target.klient.global.sessions.list({});
      expect(Array.isArray(page.items)).toBe(true);
      const count = await target.klient.global.sessions.countActive(['no-such-workspace']);
      expect(typeof count).toBe('number');
    });

    it('creates a titled session through implicit workspace materialization', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance session',
      });

      try {
        expect(created).toMatchObject({
          title: 'conformance session',
          cwd: process.cwd(),
          archived: false,
        });
        expect(created.id.length).toBeGreaterThan(0);
        expect(await target.klient.global.sessions.get(created.id)).toMatchObject({
          id: created.id,
          title: 'conformance session',
        });
      } finally {
        await target.klient.session(created.id).close();
      }
    });

    it('session createChild tags child markers while fork stays untagged', async () => {
      const parent = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance parent',
      });
      try {
        const child = await target.klient.session(parent.id).createChild();
        try {
          expect(child.custom?.['parent_session_id']).toBe(parent.id);
          expect(child.custom?.['child_session_kind']).toBe('child');
          expect(child.title).toBe('Child: conformance parent');
        } finally {
          await target.klient.session(child.id).close();
        }
        const forked = await target.klient.session(parent.id).fork();
        try {
          expect(forked.custom?.['parent_session_id']).toBeUndefined();
          expect(forked.custom?.['child_session_kind']).toBeUndefined();
        } finally {
          await target.klient.session(forked.id).close();
        }
      } finally {
        await target.klient.session(parent.id).close();
      }
    });

    it('session skills.list returns the workspace skills as summaries', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'klient-conf-skills-'));
      try {
        await mkdir(join(workDir, '.kimi-code', 'skills', 'conf-skill'), { recursive: true });
        await writeFile(
          join(workDir, '.kimi-code', 'skills', 'conf-skill', 'SKILL.md'),
          '---\nname: conf-skill\ndescription: conformance fixture skill\n---\n\n# Conf\n',
        );
        const created = await target.klient.global.sessions.create({ workDir });
        try {
          const skills = await target.klient.session(created.id).skills.list();
          expect(skills.find((skill) => skill.name === 'conf-skill')).toMatchObject({
            name: 'conf-skill',
            description: 'conformance fixture skill',
            source: 'project',
          });
        } finally {
          await target.klient.session(created.id).close();
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('promptWithSkills submits skills, args, and steerIfActive on every transport', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'klient-conf-skill-submit-'));
      try {
        await mkdir(join(workDir, '.kimi-code', 'skills', 'conf-skill'), { recursive: true });
        await writeFile(
          join(workDir, '.kimi-code', 'skills', 'conf-skill', 'SKILL.md'),
          '---\nname: conf-skill\ndescription: conformance fixture skill\n---\n\n# Conf body\n',
        );
        const created = await target.klient.global.sessions.create({ workDir });
        try {
          const agent = target.klient.session(created.id).agent('main');

          await expect(
            agent.promptWithSkills({
              input: [{ type: 'text', text: 'Run the fixture skill.' }],
              skills: [{ name: 'missing-skill' }],
            }),
          ).rejects.toThrow(/not found/i);

          const launched = await agent.promptWithSkills({
            input: [{ type: 'text', text: 'Run the fixture skill.' }],
            skills: [{ name: 'conf-skill', args: 'src/app.ts' }],
            steerIfActive: true,
          });
          expect(launched).toMatchObject({ turn_id: 0, state: 'running' });
          expect(launched.prompt_id.length).toBeGreaterThan(0);
          expect(launched.created_at.length).toBeGreaterThan(0);

          const { history } = await agent.getContext();
          const bundled = history.find(
            (message) => message.role === 'user' && message.origin?.kind === 'user',
          );
          expect(bundled?.origin).toMatchObject({
            kind: 'user',
            skillActivations: [{ skillName: 'conf-skill', skillArgs: 'src/app.ts' }],
          });
          const texts = bundled?.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text);
          expect(texts?.[0]).toContain('# Conf body');
          expect(texts?.[0]).toContain('ARGUMENTS: src/app.ts');
          expect(texts?.[1]).toBe('Run the fixture skill.');
        } finally {
          await target.klient.session(created.id).close();
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('providers.set/get/delete works and emits kosong.providers.changed', async () => {
      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      const errors: Error[] = [];
      target.klient.events.onError((error) => {
        errors.push(error);
      });
      const sub = target.klient.events.on('kosong.providers.changed', (event) => {
        events.push(event);
      });
      // Give the subscription a wire round-trip (memory is synchronous; ipc
      // and http's lazy WS need a frame exchange).
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      const name = '__klient_conformance__';
      try {
        await target.klient.global.kosong.addProvider(name, {
          type: 'openai',
          auth: { method: 'api-key', apiKey: 'conf-key' },
        });
        const got = await target.klient.global.kosong.getProvider(name);
        expect(got.has_api_key).toBe(true);

        await waitFor(
          () => events.some((event) => [...event.added, ...event.changed].includes(name)),
          5_000,
        );
      } finally {
        await target.klient.global.kosong.removeProvider(name);
        sub.dispose();
      }
      expect(errors).toEqual([]);
    });

    it('config reads respond', async () => {
      const all = await target.klient.global.config.getAll();
      expect(typeof all).toBe('object');
      expect(Array.isArray(await target.klient.global.config.diagnostics())).toBe(true);
    });

    it('config replaceSections writes several domains and clears undefined ones', async () => {
      const config = target.klient.global.config;
      const beforeProviders = await config.inspect<Record<string, unknown>>('providers');
      const beforeModels = await config.inspect<Record<string, unknown>>('models');
      try {
        await config.replaceSections({
          sections: {
            providers: {
              ...beforeProviders.userValue,
              'conf-provider': { type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' },
            },
            models: {
              ...beforeModels.userValue,
              'conf-provider/m1': { provider: 'conf-provider', model: 'm1', maxContextSize: 100 },
            },
            defaultModel: 'conf-provider/m1',
          },
        });
        expect((await config.inspect<string>('defaultModel')).userValue).toBe('conf-provider/m1');

        // A domain mapped to `undefined` is cleared; domains absent from the
        // sections record are left untouched.
        await config.replaceSections({ sections: { defaultModel: undefined } });
        expect((await config.inspect<string>('defaultModel')).userValue).toBeUndefined();
        const providers = await config.inspect<Record<string, unknown>>('providers');
        expect(providers.userValue?.['conf-provider']).toBeDefined();
      } finally {
        await config.replaceSections({
          sections: { providers: beforeProviders.userValue, models: beforeModels.userValue },
        });
      }
    });

    it('keeps a credential binding edited while the registry response is in flight', async () => {
      const { config, kosong } = target.klient.global;
      const domains = ['providers', 'models', 'defaultModel', 'defaultProvider', 'thinking'];
      const before = Object.fromEntries(
        await Promise.all(domains.map(async (domain) => [
          domain, (await config.inspect(domain)).userValue,
        ])),
      );
      const url = 'https://registry.example.test/api.json';
      const source = { kind: 'apiJson', url, apiKey: '' };
      const provider = { type: 'openai', baseUrl: 'https://owned.example.test/v1', source };
      try {
        await config.replaceSections({
          sections: {
            providers: { owned: { ...provider, apiKeyEnv: 'FIRST_EXAMPLE_KEY' } },
            models: {},
            defaultModel: undefined,
            defaultProvider: undefined,
            thinking: undefined,
          },
        });
        setModelsDevUpstreamForTest({
          fetchImpl: async () => {
            await config.set({
              domain: 'providers',
              patch: { owned: { apiKeyEnv: 'SECOND_EXAMPLE_KEY' } },
            });
            return Response.json({
              owned: {
                id: 'owned',
                name: 'Owned',
                type: 'openai',
                api: provider.baseUrl,
                models: { m1: { id: 'm1' } },
              },
            });
          },
        });
        await kosong.importCustomRegistry({ url, setDefaultWhenUnset: false });
        await config.reload();
        const providers = await config.inspect<Record<string, { apiKeyEnv?: string }>>('providers');
        expect(providers.userValue?.['owned']?.apiKeyEnv).toBe('SECOND_EXAMPLE_KEY');
      } finally {
        resetModelsDevUpstreamForTest();
        await config.replaceSections({ sections: before });
      }
    });

    it('hostFs.home() returns the host home and recent roots', async () => {
      const home = await target.klient.global.hostFs.home();
      expect(home.home.length).toBeGreaterThan(0);
      expect(Array.isArray(home.recent_roots)).toBe(true);

      const browse = await target.klient.global.hostFs.browse(home.home);
      expect(browse.path).toBe(home.home);
      expect(Array.isArray(browse.entries)).toBe(true);
    });

    it('files save/get/delete round-trips bytes through the file store', async () => {
      const files = target.klient.global.files;
      const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
      const meta = await files.save({
        data: bytes,
        filename: 'conformance.bin',
        mimeType: 'application/octet-stream',
        expiresInSec: 3600,
      });
      expect(meta.id.startsWith('f_')).toBe(true);
      expect(meta.name).toBe('conformance.bin');
      expect(meta.media_type).toBe('application/octet-stream');
      expect(meta.size).toBe(bytes.length);
      expect(typeof meta.expires_at).toBe('string');

      const downloaded = await files.get(meta.id);
      expect(downloaded.meta).toEqual(meta);
      expect([...downloaded.data]).toEqual([...bytes]);

      await files.delete(meta.id);
      // Both transports surface a deleted/expired upload as the same public
      // RPCError code, never the engine's raw error type.
      await expect(files.get(meta.id)).rejects.toMatchObject({ name: 'RPCError', code: 40404 });
    });

    it('kosong lists models/providers and preserves generation contracts', async () => {
      const kosong = target.klient.global.kosong;
      expect(Array.isArray(await kosong.listModels())).toBe(true);
      expect(Array.isArray(await kosong.listProviders())).toBe(true);

      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      const sub = target.klient.events.on('kosong.models.changed', (event) => {
        events.push(event);
      });
      // See kosong.providers.changed above — give the subscription a wire round-trip.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      const id = '__klient_conformance__';
      try {
        await kosong.addProvider({
          id,
          model: 'conf-model',
          protocol: 'openai',
          baseUrl: 'http://127.0.0.1:1',
          auth: { method: 'api-key', apiKey: 'conf-key' },
        });

        await waitFor(
          () => events.some((event) => [...event.added, ...event.changed].includes(id)),
          5_000,
        );
      } finally {
        await kosong.removeProvider(id);
        sub.dispose();
      }

      const kimiId = '__klient_kimi_thinking__';
      const kimiProviderId = '__klient_kimi_provider__';
      await kosong.addProvider(kimiProviderId, {
        type: 'kimi',
        baseUrl: 'https://example.test/v1',
        auth: { method: 'api-key', apiKey: 'conf-key' },
      });
      await target.app.accessor.get(IModelService).set(kimiId, {
        provider: kimiProviderId,
        model: 'conf-kimi',
        maxContextSize: 4096,
        capabilities: ['thinking'],
        supportEfforts: ['low', 'high'],
        defaultEffort: 'high',
      });
      const bodies: Record<string, unknown>[] = [];
      const chunk = JSON.stringify({
        id: 'chatcmpl-conf',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'conf-kimi',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      vi.stubGlobal('fetch', (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        bodies.push(JSON.parse(await new Request(input, init).text()) as Record<string, unknown>);
        return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch);
      const consume = async (stream: AsyncIterable<unknown>): Promise<void> => {
        let finished = false;
        for await (const event of stream) {
          if ((event as { readonly type?: string }).type === 'finish') finished = true;
        }
        expect(finished).toBe(true);
      };
      const publicInput = {
        systemPrompt: '',
        tools: [],
        messages: [
          {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: 'hi' },
              {
                type: 'image_url' as const,
                imageUrl: { url: 'data:image/png;base64,QUJD', id: 'image-1' },
              },
            ],
            toolCalls: [],
          },
        ],
      };
      const coreInput = {
        systemPrompt: '',
        tools: [],
        messages: [
          {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: 'hi' },
              {
                type: 'image_url' as const,
                imageUrl: { url: 'data:image/png;base64,QUJD', id: 'image-1' },
              },
            ],
          },
        ],
      };
      try {
        await consume(kosong.generate(kimiId, publicInput, { thinkingEffort: 'on' }));
        await consume(kosong.generate(kimiId, publicInput, { thinkingEffort: 'max' }));
        const catalog = target.app.accessor.get(IModelCatalog);
        const registry = target.app.accessor.get(IProtocolAdapterRegistry);
        await consume(
          generateModel(registry.request(catalog.get(kimiId), { thinkingEffort: 'on' }), coreInput, undefined, {
            thinkingEffort: 'on',
          }),
        );
        await consume(
          generateModel(registry.request(catalog.get(kimiId), { thinkingEffort: 'max' }), coreInput, undefined, {
            thinkingEffort: 'max',
          }),
        );
        expect(bodies.map((body) => body['thinking'])).toEqual([
          { type: 'enabled' },
          { type: 'enabled', effort: 'max' },
          { type: 'enabled' },
          { type: 'enabled', effort: 'max' },
        ]);
        const expectedMessages = [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,QUJD', id: 'image-1' },
              },
            ],
          },
        ];
        expect(bodies).toHaveLength(4);
        for (const body of bodies) {
          expect(body['messages']).toEqual(expectedMessages);
        }

        const responsePart = {
          type: 'image_url' as const,
          imageUrl: { url: 'data:image/png;base64,QUJD', id: 'response-image', name: 'pixel.png' },
        };
        const fakeRequester: LlmRequester = {
          generate: (_config, _content, control) => {
            control.onEvent?.({ type: 'llm.streaming.part', part: responsePart });
            control.onEvent?.({
              type: 'llm.streaming.finish',
              finish: { finishReason: 'completed', rawFinishReason: 'stop' },
            });
            control.onEvent?.({ type: 'llm.done' });
            return Promise.resolve();
          },
        };
        const request = registry.request.bind(registry);
        const generate = vi.spyOn(registry, 'request').mockImplementation((model, params) =>
          coreRequesterFromA(request(model, params), fakeRequester),
        );
        try {
          const responseEvents: unknown[] = [];
          for await (const event of kosong.generate(kimiId, publicInput)) {
            responseEvents.push(event);
          }
          const publicPart = {
            type: 'image_url',
            imageUrl: {
              url: 'data:image/png;base64,QUJD',
              id: 'response-image',
              name: 'pixel.png',
            },
          };
          expect(responseEvents).toStrictEqual([
            { type: 'part', part: publicPart },
            expect.objectContaining({
              type: 'finish',
              message: { role: 'assistant', content: [publicPart], toolCalls: [] },
            }),
            expect.objectContaining({
              type: 'timing',
              firstTokenLatencyMs: expect.any(Number),
              streamDurationMs: expect.any(Number),
            }),
          ]);
        } finally {
          generate.mockRestore();
        }
      } finally {
        vi.unstubAllGlobals();
        await kosong.removeProvider(kimiId);
        await kosong.removeProvider(kimiProviderId);
      }
    });

    it('flags / plugins / auth read models respond', async () => {
      expect(Array.isArray(await target.klient.global.flags.list())).toBe(true);
      expect(Array.isArray(await target.klient.global.flags.enabledIds())).toBe(true);
      expect(typeof await target.klient.global.flags.snapshot()).toBe('object');
      expect(Array.isArray(await target.klient.global.plugins.list())).toBe(true);
      const status = await target.klient.global.auth.status();
      expect(typeof status.loggedIn).toBe('boolean');
    });

    it('global mcp round-trips user-level server CRUD', async () => {
      const mcp = target.klient.global.mcp;
      const cwd = await mkdtemp(join(tmpdir(), 'klient-conf-mcp-crud-'));
      try {
        expect(await mcp.list({ cwd })).toEqual([]);

        const added = await mcp.add({
          cwd,
          server: {
            name: 'conf-mcp',
            transport: 'stdio',
            command: 'conf-command',
            env: { TOKEN: 'secret' },
          },
        });
        const entry = added.find((server) => server.name === 'conf-mcp');
        // Mutable (user-level) entries carry the full config for edit prefill.
        expect(entry).toMatchObject({
          name: 'conf-mcp',
          source: 'global',
          mutable: true,
          config: { transport: 'stdio', command: 'conf-command', env: { TOKEN: 'secret' } },
        });

        await mcp.update({
          cwd,
          server: { name: 'conf-mcp', transport: 'stdio', command: 'conf-command-2' },
        });
        expect((await mcp.get({ name: 'conf-mcp', cwd })).config).toMatchObject({
          command: 'conf-command-2',
        });

        await mcp.remove({ name: 'conf-mcp', cwd });
        expect(await mcp.list({ cwd })).toEqual([]);
        await expect(mcp.get({ name: 'conf-mcp', cwd })).rejects.toMatchObject({
          name: 'RPCError',
          code: 40408,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('global mcp probes an inline server config without persisting it', async () => {
      const mcp = target.klient.global.mcp;
      // Inline probe against a scratch cwd: the binary runs but never
      // speaks MCP, so the connection test reports a clean failure.
      const probeCwd = await mkdtemp(join(tmpdir(), 'klient-conf-mcp-probe-'));
      try {
        const probe = await mcp.test({
          server: {
            name: 'conf-probe',
            transport: 'stdio',
            command: process.execPath,
            args: ['--version'],
            startupTimeoutMs: 10_000,
          },
          cwd: probeCwd,
        });
        expect(probe.success).toBe(false);
        expect(typeof probe.output).toBe('string');
      } finally {
        await rm(probeCwd, { recursive: true, force: true });
      }
      expect(await mcp.list()).toEqual([]);
    });

    it('global mcp resolves locators and classifies auth offline', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: { name: 'conf-mcp', transport: 'stdio', command: 'conf-command' },
      });
      try {
        // The locator surface: resolve a legacy name, inspect nothing/all.
        expect(await mcp.resolveByName({ name: 'conf-mcp' })).toEqual({
          source: 'global',
          name: 'conf-mcp',
        });
        expect(await mcp.inspect({ targets: [] })).toEqual([]);
        // An omitted `targets` ahead of a present options arg must mean "the
        // whole catalog" on every transport (ipc encodes it as `null`).
        expect((await mcp.inspect({})).map((i) => i.runtimeName)).toContain('conf-mcp');
        await expect(
          mcp.inspect({ targets: [{ source: 'global', name: 'conf-missing' }] }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40408 });

        // Offline auth classification of a stdio server needs no probe, and
        // an OAuth flow against a stdio target is request.invalid → 40001.
        expect(await mcp.authStatuses()).toEqual([
          { name: 'conf-mcp', authStatus: 'not-applicable' },
        ]);
        await expect(
          mcp.beginAuth({ locator: { source: 'global', name: 'conf-mcp' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
      } finally {
        await mcp.remove({ name: 'conf-mcp' });
      }
    });

    it('global mcp completeAuth rejects an unknown flowId with 40001', async () => {
      const mcp = target.klient.global.mcp;
      await expect(mcp.completeAuth({ flowId: 'conf-unknown-flow' })).rejects.toMatchObject({
        name: 'RPCError',
        code: 40001,
      });
    });

    it('global mcp OAuth failures map to the 40929 wire code on every transport', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: {
          name: 'conf-oauth-failure',
          transport: 'http',
          url: 'http://127.0.0.1:1/mcp',
          auth: 'oauth',
        },
      });
      try {
        await expect(
          mcp.beginAuth({ locator: { source: 'global', name: 'conf-oauth-failure' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40929 });
      } finally {
        await mcp.remove({ name: 'conf-oauth-failure' });
      }
    });

    it('global mcp cancelAuth ignores an unknown flowId', async () => {
      const mcp = target.klient.global.mcp;
      await expect(mcp.cancelAuth({ flowId: 'conf-unknown-flow' })).resolves.toBeUndefined();
    });

    it('global mcp resetAuth clears a remote oauth server through the transport', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: {
          name: 'conf-oauth',
          transport: 'http',
          url: 'https://example.com/mcp',
          auth: 'oauth',
        },
      });
      try {
        // Invalidate is offline: no stored grant and no network needed.
        await expect(
          mcp.resetAuth({ locator: { source: 'global', name: 'conf-oauth' } }),
        ).resolves.toBeUndefined();
      } finally {
        await mcp.remove({ name: 'conf-oauth' });
      }
    });

    it('global mcp resetAuth rejects a stdio locator with 40001', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: { name: 'conf-stdio', transport: 'stdio', command: 'conf-command' },
      });
      try {
        await expect(
          mcp.resetAuth({ locator: { source: 'global', name: 'conf-stdio' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
      } finally {
        await mcp.remove({ name: 'conf-stdio' });
      }
    });

    it('agent environment binding and media events are available through every transport', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance environment',
      });
      try {
        const agent = target.klient.session(created.id).agent('main');
        const binding = await agent.getEnvironment();
        expect(binding.environmentId).toBe('local');
        expect(binding).toEqual({ environmentId: 'local' });
        expect(await agent.getEnvironment()).toEqual(binding);

        const seen: unknown[] = [];
        const sub = agent.events.on('tool.result', (event) => seen.push(event));
        await new Promise((resolve) => {
          setTimeout(resolve, 300);
        });
        try {
          const live = getLiveSessionById(target.app.accessor, created.id);
          if (live === undefined) throw new Error('expected a live session');
          const main = live.accessor.get(IAgentLifecycleService).handleOf('main');
          if (main === undefined) throw new Error('expected the main agent');
          main.accessor.get(IEventBus).publish(
            new ToolResultEvent({
              agentId: 'main',
              turnId: 1,
              toolCallId: 'call-media',
              output: [
                { type: 'text', text: 'media' },
                { type: 'image_url', imageUrl: { url: 'data:image/png;base64,QUJD' } },
              ],
            }),
          );
          await waitFor(() => seen.length === 1, 2_000);
          expect(seen[0]).toMatchObject({
            output: [
              { type: 'text', text: 'media' },
              {
                type: 'image_url',
                imageUrl: expect.objectContaining({ url: 'data:image/png;base64,QUJD' }),
              },
            ],
          });
        } finally {
          sub.dispose();
        }
      } finally {
        await target.klient.session(created.id).close();
      }
    });

    it('agent commands list and run a contributed command', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance commands',
      });
      const calls: string[] = [];

      // A dynamic App-scope unit contributing one command into the
      // `CommandContribution` collection — the same path a Feature takes.
      class ConformanceCommands extends Service {
        static override readonly name = 'klient-conformance-commands';
        constructor() {
          super();
          this.provide(CommandContribution, {
            name: 'conformance-echo',
            description: 'records its args',
            run: (ctx) => {
              calls.push(ctx.args);
            },
          });
        }
      }

      const featureManager = target.app.accessor.get(IFeatureManager);
      const handle = featureManager.provideUnit(ConformanceCommands);
      try {
        const agent = target.klient.session(created.id).agent('main');

        // Dynamic assembly goes through the cascade — poll until visible.
        let infos = await agent.listCommands();
        const deadline = Date.now() + 5_000;
        while (!infos.some((command) => command.name === 'conformance-echo')) {
          if (Date.now() > deadline) break;
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
          infos = await agent.listCommands();
        }
        expect(infos.map((command) => command.name)).toContain('conformance-echo');
        const echo = infos.find((command) => command.name === 'conformance-echo');
        expect(echo).toMatchObject({ name: 'conformance-echo', description: 'records its args' });
        expect(typeof echo?.source).toBe('string');

        await agent.runCommand({ name: 'conformance-echo', args: 'hello commands' });
        expect(calls).toEqual(['hello commands']);

        // Unknown names fail with a coded engine error.
        await expect(agent.runCommand({ name: 'conformance-missing' })).rejects.toThrow(
          /Unknown command/,
        );
      } finally {
        await handle.dispose();
        await target.klient.session(created.id).close();
      }
    });

    it('treats a client-chosen promptId as a pure correlation id', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance prompt correlation',
      });
      try {
        const agent = target.klient.session(created.id).agent('main');
        const first = await agent.prompt({
          input: [{ type: 'text', text: 'first' }],
          promptId: 'submission-1',
        });
        expect(first).toEqual({ turn_id: 0 });
        const second = await agent.prompt({
          input: [{ type: 'text', text: 'duplicate' }],
          promptId: 'submission-1',
        });
        expect(second === undefined || typeof second.turn_id === 'number').toBe(true);
      } finally {
        await target.klient.session(created.id).close();
      }
    });
  });
}
