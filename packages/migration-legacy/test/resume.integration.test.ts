/**
 * End-to-end check that a migrated session is actually visible to — and
 * resumable by — real kimi-core. The migrator writes session buckets named by
 * `computeWorkdirBucket`; kimi-core's session picker (`SessionStore.list`)
 * locates sessions purely by `readdir(encodeWorkDirKey(workDir))`. If the two
 * bucket algorithms diverge (see review item C1), migrated sessions become
 * silently invisible — this test fails fast in that case.
 *
 * The resume test additionally drives a real `Session.resume()`: it reads the
 * migrated `state.json`, instantiates the `main` agent from
 * `agents.main.homedir`, and replays that agent's `wire.jsonl`. If
 * `agents.main.homedir` does not point at `<sessionDir>/agents/main` (where the
 * migrator writes the translated history), the resumed agent's context is
 * empty and the migrated history is lost.
 *
 * agent-core API used:
 *   - `SessionStore` (constructor: `new SessionStore(homeDir)`)
 *   - `SessionStore.list({ workDir })`
 *   - `encodeWorkDirKey` / `normalizeWorkDir`
 *     all from `@moonshot-ai/agent-core/session/store`.
 *   - `Session` (constructor + `resume()` + `agents` map), from
 *     `@moonshot-ai/agent-core`; `localKaos` from `@moonshot-ai/kaos`. After
 *     `resume()`, `session.agents.get('main').context.messages` exposes the
 *     replayed message history.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SessionStore,
  encodeWorkDirKey,
  normalizeWorkDir,
} from '@moonshot-ai/agent-core/session/store';
import { Session, type SDKSessionRPC } from '@moonshot-ai/agent-core';
import { LocalKaos } from '@moonshot-ai/kaos';

import { migrateOneSession, type MigrateOneResult } from '../src/sessions/migrate-one.js';
import { computeWorkdirBucket } from '../src/sessions/workdir-bucket.js';

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: 'unused', isError: true })),
  } as unknown as SDKSessionRPC;
}

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const WORK_DIR = '/Users/example/proj';

let targetHome: string;
beforeEach(async () => {
  targetHome = await mkdtemp(join(tmpdir(), 'resume-integ-'));
});
afterEach(async () => {
  await rm(targetHome, { recursive: true, force: true });
});

describe('migrated session loads in real kimi-core', () => {
  it('computeWorkdirBucket matches kimi-core encodeWorkDirKey', () => {
    expect(computeWorkdirBucket(WORK_DIR)).toBe(
      encodeWorkDirKey(normalizeWorkDir(WORK_DIR)),
    );
  });

  it('SessionStore.list() finds a migrated session under the same workDir', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'with-tool-calls'),
      oldSessionUuid: 'integ-uuid',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');

    // `SessionStore(homeDir)` resolves sessions under `homeDir/sessions`,
    // which is exactly where the migrator wrote.
    const store = new SessionStore(targetHome);
    const sessions = await store.list({ workDir: WORK_DIR });

    // This exercises kimi-core's bucket lookup end-to-end: list() does
    // `readdir(encodeWorkDirKey(workDir))` and never consults the index.
    expect(sessions.map((s) => s.id)).toContain('ses_integ-uuid');

    const migrated = sessions.find((s) => s.id === 'ses_integ-uuid');
    expect(migrated?.metadata?.['imported_from_kimi_cli']).toBe(true);
  });

  it('migrated wire history is non-empty and resumable', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-resume',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>)
      .targetDir;

    const wire = await readFile(join(targetDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    const events = wire
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string });
    expect(events[0]?.type).toBe('metadata');
    expect(events.filter((e) => e.type === 'context.append_message').length).toBeGreaterThan(0);
  });

  it('real kimi-core Session.resume() loads the migrated message history', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-resume',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>)
      .targetDir;

    // Drive a real kimi-core resume: `Session.resume()` reads `state.json`
    // from `homedir`, then instantiates the `main` agent from
    // `agents.main.homedir` and replays *that directory's* `wire.jsonl`.
    // If `agents.main.homedir` were the project workdir (the bug), the agent
    // would replay an absent file and the history would be empty.
    const session = new Session({
      runtime: { kaos: (await LocalKaos.create()).withCwd(WORK_DIR) },
      id: 'ses_tiny-resume',
      homedir: targetDir,
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    try {
      await session.resume();
      const mainAgent = session.agents.get('main');
      expect(mainAgent).toBeDefined();

      // The migrated wire carries no `config.update` bootstrap events, so a
      // naive replay leaves the agent with an empty system prompt and no
      // tools. `Session.resume()` re-applies the default profile when it
      // detects this — assert it took effect so the resumed session is usable.
      expect((mainAgent?.config.systemPrompt ?? '').length).toBeGreaterThan(0);

      const messages = mainAgent?.context.messages ?? [];
      // The fixture has a user + assistant message — both must be replayed.
      expect(messages.length).toBeGreaterThan(0);
      const transcript = messages
        .flatMap((m) => m.content)
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
      expect(transcript).toContain('hi');
      expect(transcript).toContain('Hello! How can I help?');
    } finally {
      await session.close();
    }
  });
});
