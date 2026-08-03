/**
 * G2 rust-sessions round trip: create → list → metadata → close/restore →
 * archive → delete through the rust transport. Run with
 * `KIMI_AGENT_FORCE_STDIO=1` (the engine session surface is stdio-only).
 */
import { describe, expect, it } from 'vitest';

import * as rustLoop from '@moonshot-ai/kimi-agent/rust-loop';

import { createKlientFromChannel } from '#/core/klient';
import { RustChannel } from '#/transports/rust/index';

describe('rust session lifecycle + metadata', () => {
  it('round-trips create → list → metadata → close/restore → archive → delete', async () => {
    // One shared channel: the klient facade drives the round trip; the raw
    // channel reaches `sessionLifecycleService.delete`, which has no facade
    // surface (the facade only uses it for create-cleanup).
    const channel = new RustChannel({
      rust: rustLoop as unknown as typeof rustLoop,
      host: { homeDir: process.cwd(), configPath: `${process.cwd()}/config.toml` },
    });
    const klient = createKlientFromChannel(channel);
    let sessionId: string | undefined;
    try {
      // create — workDir becomes the engine's session work_dir
      const meta = await klient.global.sessions.create({ workDir: process.cwd() });
      sessionId = meta.id;
      expect(sessionId).toBeTruthy();
      expect(meta.archived).toBe(false);

      // list sees the new session
      const page = await klient.global.sessions.list({});
      expect(page.items.some((s) => s.id === sessionId)).toBe(true);

      const session = klient.session(sessionId);

      // metadata writes
      await session.setTitle('rust session test');
      await session.update({ custom: { owner: 'klient' } });
      await session.setArchived(true);

      const read = await session.get();
      expect(read.id).toBe(sessionId);
      expect(read.title).toBe('rust session test');
      expect(read.isCustomTitle).toBe(true);
      expect(read.archived).toBe(true);
      expect(read.custom).toEqual({ owner: 'klient' });

      // close → restore round trip (metadata survives both)
      await session.close();
      expect(await session.restore()).toBe(true);
      expect((await session.get()).title).toBe('rust session test');

      // archive marks metadata (no engine archive concept)
      await session.archive();
      expect((await session.get()).archived).toBe(true);

      // delete removes the persisted record; read then reports not-found
      await channel.call({ sessionId }, 'sessionLifecycleService', 'delete', [{ id: sessionId }]);
      await expect(session.get()).rejects.toThrow(/session not found/);
      const after = await klient.global.sessions.list({});
      expect(after.items.some((s) => s.id === sessionId)).toBe(false);
    } finally {
      if (sessionId !== undefined) {
        await channel
          .call({ sessionId }, 'sessionLifecycleService', 'delete', [{ id: sessionId }])
          .catch(() => {});
      }
      await klient.close();
    }
  });
});
