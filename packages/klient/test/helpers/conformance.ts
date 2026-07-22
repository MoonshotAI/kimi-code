/**
 * Shared conformance suite — the guarantee that the ipc and memory
 * transports are interchangeable. Every transport test file runs the exact
 * same assertions against a real in-process engine; only the `before` setup
 * differs per file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Klient } from '../../src/index.js';

export interface KlientConformanceTarget {
  readonly klient: Klient;
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

    it('hostFs.home() returns the host home and recent roots', async () => {
      const home = await target.klient.global.hostFs.home();
      expect(home.home.length).toBeGreaterThan(0);
      expect(Array.isArray(home.recent_roots)).toBe(true);

      const browse = await target.klient.global.hostFs.browse(home.home);
      expect(browse.path).toBe(home.home);
      expect(Array.isArray(browse.entries)).toBe(true);
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
  });
}
