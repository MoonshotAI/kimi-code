/**
 * Dual-backend rewrite of scenario `05-workspace`: workspace registration,
 * session creation rooted at the workspace, index linkage, and delete
 * semantics — all through the global facade. No model required.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { defineDualSuite } from '../../helpers/dual.js';

defineDualSuite('workspace', {}, ({ klient }) => {
  it('workspace + session lifecycle', async () => {
    const k = klient();
    const root = await realpath(await mkdtemp(join(tmpdir(), 'klient-dual-ws-')));
    try {
      const ws = await k.global.workspaces.createOrTouch({ root, name: 'dual-workspace' });
      expect(ws.id.length).toBeGreaterThan(0);
      expect(ws.name).toBe('dual-workspace');

      const got = await k.global.workspaces.get(ws.id);
      expect(got?.root).toBe(ws.root);

      const session = await k.global.sessions.create({ workDir: ws.root });
      expect(session.cwd).toBe(ws.root);

      const listed = await k.global.sessions.list({ workspaceIds: [ws.id] });
      expect(listed.items.some((s) => s.id === session.id)).toBe(true);

      await k.global.workspaces.delete(ws.id);
      expect((await k.global.workspaces.list()).some((w) => w.id === ws.id)).toBe(false);

      // Deleting the workspace does not delete the session.
      expect((await k.session(session.id).get()).id).toBe(session.id);
      await k.session(session.id).archive();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  }, 30_000);
});
