/**
 * Smoke test for the rust transport: the engine spawns over stdio and the
 * sessionIndex service round-trips. Run with `KIMI_AGENT_FORCE_STDIO=1`
 * (the vitest config sets it, mirroring the node-sdk suite).
 */
import { describe, expect, it } from 'vitest';

import { createKlientFromRust } from '#/transports/rust/index';

describe('rust transport smoke', () => {
  it('lists engine sessions through the rust channel', async () => {
    const klient = createKlientFromRust({ homeDir: process.cwd() });
    try {
      const page = await klient.global.sessions.list({});
      expect(Array.isArray(page.items)).toBe(true);
    } finally {
      await klient.close();
    }
  });

  it('returns undefined for an unknown session id', async () => {
    const klient = createKlientFromRust({ homeDir: process.cwd() });
    try {
      const summary = await klient.global.sessions.get('ses_does_not_exist');
      expect(summary).toBeUndefined();
    } finally {
      await klient.close();
    }
  });
});
