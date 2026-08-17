/**
 * Shared conformance suite — the guarantee that the ipc and memory
 * transports are interchangeable. Every transport test file runs the exact
 * same assertions against a real in-process engine; only the `before` setup
 * differs per file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Service } from '@moonshot-ai/agent-core-v2/_base/di/service';
import { CommandContribution } from '@moonshot-ai/agent-core-v2/agent/command/commandContribution';
import { IFeatureManager } from '@moonshot-ai/agent-core-v2/app/feature/featureManager';
import { getLiveSessionById } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionLookup';
import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { IAgentPromptService, reservePrompt } from '@moonshot-ai/agent-core-v2/agent/prompt/prompt';

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
      const workspaces = target.klient.global.workspaces;
      const created = await workspaces.createOrTouch({ root: process.cwd(), name: 'conformance' });
      expect(created.id.length).toBeGreaterThan(0);

      const fetched = await workspaces.get(created.id);
      expect(fetched?.name).toBe('conformance');

      const updated = await workspaces.update({ id: created.id, patch: { name: 'conformance-2' } });
      expect(updated?.name).toBe('conformance-2');

      const list = await workspaces.list();
      expect(list.some((w) => w.id === created.id)).toBe(true);

      await workspaces.delete(created.id);
      expect(await workspaces.get(created.id)).toBeUndefined();
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

    it('kosong lists models/providers and anonymous provider round-trips', async () => {
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
    });

    it('flags / plugins / auth read models respond', async () => {
      expect(Array.isArray(await target.klient.global.flags.list())).toBe(true);
      expect(Array.isArray(await target.klient.global.flags.enabledIds())).toBe(true);
      expect(typeof await target.klient.global.flags.snapshot()).toBe('object');
      expect(Array.isArray(await target.klient.global.plugins.list())).toBe(true);
      const status = await target.klient.global.auth.status();
      expect(typeof status.loggedIn).toBe('boolean');
    });

    it('agent runtime binding is available through every transport', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance runtime',
      });
      try {
        const agent = target.klient.session(created.id).agent('main');
        const binding = await agent.getRuntime();
        expect(binding.runtimeId).toBe('local');
        expect(binding.workspaceId.length).toBeGreaterThan(0);
        await expect(agent.switchRuntime('missing-runtime')).rejects.toThrow(/missing-runtime/);
        expect(await agent.getRuntime()).toEqual(binding);
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

    it('propagates prompt id conflicts with the same 40927 error', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance prompt conflict',
      });
      const session = getLiveSessionById(target.app.accessor, created.id);
      if (session === undefined) throw new Error('conformance session was not materialized');
      const main = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
      const reservation = reservePrompt(main.accessor.get(IAgentPromptService), 'submission-1');
      try {
        await expect(
          target.klient.session(created.id).agent('main').prompt({
            input: [{ type: 'text', text: 'duplicate' }],
            promptId: 'submission-1',
          }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40927 });
      } finally {
        reservation.dispose();
        await target.klient.session(created.id).close();
      }
    });
  });
}
