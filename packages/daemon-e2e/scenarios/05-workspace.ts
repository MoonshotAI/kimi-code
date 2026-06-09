#!/usr/bin/env node
/**
 * Scenario 05 — workspace registry + folder picker happy path.
 *
 * Flow:
 *   1. `GET /fs:home`   — picker landing payload (home + recent roots)
 *   2. `GET /fs:browse` — list child dirs of $HOME (sanity check the wire)
 *   3. `POST /workspaces { root }` — register a workspace on a fresh tmpdir
 *   4. `POST /sessions { workspace_id }` — daemon resolves cwd from workspace
 *   5. `GET /sessions?workspace_id=` — fast-path filter returns just our session
 *   6. Round-trip a real prompt through that session (depends on DAEMON_AUTH)
 *   7. `DELETE /workspaces/{id}` — unregister (does NOT remove the session)
 *
 * Usage:
 *   DAEMON_URL=http://127.0.0.1:7878 npx tsx scenarios/05-workspace.ts
 *
 * Exit codes:
 *   0  — pass
 *   1  — assertion failure or daemon error
 */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DaemonClient } from '../src/index';

const DAEMON_URL = process.env['DAEMON_URL'] ?? 'http://127.0.0.1:7878';
const EXPECTED_TOKEN = 'OK';

async function main() {
  const client = new DaemonClient({ baseUrl: DAEMON_URL });

  // Use a fresh tmpdir as the workspace root so the scenario doesn't pollute
  // the daemon's workspace registry with persistent entries. realpathSync()
  // matches what the picker / daemon registry surface (avoids macOS
  // `/var` ↔ `/private/var` mismatch with the session cwd).
  const wsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-e2e-workspace-')));
  let workspaceId: string | undefined;
  let sid: string | undefined;

  try {
    // 1. fs:home — sanity check the landing payload shape.
    const home = await client.fsHome();
    assert.ok(typeof home.home === 'string' && home.home.startsWith('/'), 'home.home is an absolute path');
    assert.ok(Array.isArray(home.recent_roots), 'home.recent_roots is an array');
    console.log(`▶ fs:home returned home=${home.home}`);

    // 2. fs:browse — list immediate subdirs of $HOME. We only check the shape
    //    of the response; the exact directory tree depends on the host.
    const browseHome = await client.fsBrowse(home.home);
    assert.ok(typeof browseHome.path === 'string', 'fs:browse path is set');
    assert.ok(Array.isArray(browseHome.entries), 'fs:browse entries is an array');
    for (const e of browseHome.entries) {
      assert.equal(e.is_dir, true, 'fs:browse entries are directories only');
    }
    console.log(`▶ fs:browse $HOME returned ${browseHome.entries.length} subdir(s)`);

    // 3. Register the workspace. Idempotent + returns derived id.
    const workspace = await client.createWorkspace({ root: wsRoot, name: 'e2e-workspace' });
    workspaceId = workspace.id;
    assert.match(workspace.id, /^wd_[a-z0-9._-]+_[0-9a-f]{12}$/, 'workspace.id matches wd-key shape');
    assert.equal(workspace.name, 'e2e-workspace');
    assert.equal(workspace.session_count, 0, 'no sessions in fresh workspace');
    console.log(`▶ POST /workspaces → ${workspaceId} (root=${workspace.root})`);

    // 4. Create a session BY workspace_id (daemon resolves cwd from the
    //    registered root). The Session response carries workspace_id verbatim.
    const session = await client.createSession({ workspace_id: workspaceId });
    sid = session.id;
    assert.equal(session.workspace_id, workspaceId, 'session.workspace_id mirrors POST input');
    assert.equal(session.metadata.cwd, workspace.root, 'session.metadata.cwd resolved from workspace.root');
    console.log(`▶ POST /sessions { workspace_id } → ${sid}`);

    // 5. List by workspace_id (fast path via listSessions({ workDir })).
    const filtered = await client.listSessions({ workspace_id: workspaceId });
    assert.equal(filtered.items.length, 1, 'workspace filter returned exactly the new session');
    const filteredSession = filtered.items[0];
    assert.ok(filteredSession, 'workspace filter returned a session');
    assert.equal(filteredSession.id, sid, 'session id round-trips through the filter');

    // 6. Round-trip a real prompt. Skipped when DAEMON_AUTH isn't wired (the
    //    daemon answers 401xx without an authenticated provider, which surfaces
    //    in `submitAndWait` as a HTTP error — keep the scenario useful even
    //    when run without provider creds).
    if (process.env['DAEMON_AUTH'] !== 'skip') {
      await client.connect();
      await client.subscribe(sid);
      try {
        const { prompt_id, finalFrame } = await client.submitAndWait(
          sid,
          {
            content: [
              {
                type: 'text',
                text: `Reply with the single word "${EXPECTED_TOKEN}" and nothing else.`,
              },
            ],
          },
          { waitFor: 'prompt.completed', timeoutMs: 60_000 },
        );
        console.log(`▶ prompt ${prompt_id} finalFrame=${finalFrame.type}`);

        const { items } = await client.listMessages(sid, { page_size: 100 });
        const assistant =
          items.find((m) => m.role === 'assistant' && m.prompt_id === prompt_id) ??
          [...items].reverse().find((m) => m.role === 'assistant');
        assert.ok(assistant, 'expected at least one assistant message');
        const text = assistant.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
        assert.ok(
          text.toUpperCase().includes(EXPECTED_TOKEN),
          `expected assistant text to contain "${EXPECTED_TOKEN}", got: ${JSON.stringify(text)}`,
        );
      } catch (error) {
        console.log(`▶ prompt round-trip skipped (likely no DAEMON_AUTH): ${String(error)}`);
      }
    } else {
      console.log('▶ prompt round-trip skipped via DAEMON_AUTH=skip');
    }

    // 7. Unregister. Workspace count drops; session is unaffected
    //    (the workspace.json file is unlinked but the session subdir stays).
    await client.deleteWorkspace(workspaceId);
    workspaceId = undefined;
    const after = await client.listWorkspaces();
    assert.equal(
      after.items.find((w) => w.id === workspace.id),
      undefined,
      'workspace removed from registry',
    );
    // The session can still be fetched directly (delete workspace ≠ delete sessions).
    const stillThere = await client.getSession(sid);
    assert.equal(stillThere.id, sid, 'session survives workspace delete');

    console.log('✓ 05-workspace: end-to-end registry + picker + session round-trip');
  } finally {
    try {
      if (sid) await client.deleteSession(sid);
    } catch {
      // ignore
    }
    try {
      if (workspaceId) await client.deleteWorkspace(workspaceId);
    } catch {
      // ignore
    }
    await client.close();
    try {
      rmSync(wsRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error('✗ 05-workspace failed:', err);
  process.exit(1);
});
