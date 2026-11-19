import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as slowDisk } from 'node:timers/promises';

import { IFileSystemStorageService } from '@moonshot-ai/agent-core-v2';
import { say } from '@moonshot-ai/testkit/model';
import { kapFixtures, type KapFixtures } from '@moonshot-ai/testkit/vitest';
import { expect, test as base } from 'vitest';

import { startServer, type RunningServer } from '../src';

const test = base.extend<KapFixtures<RunningServer>>(kapFixtures({ startServer }));

const SLOW_WRITE_MS = 1_000;

async function wireRecordTypes(dataDir: string, sessionId: string): Promise<string[]> {
  const sessions = join(dataDir, 'sessions');
  for (const workspace of await readdir(sessions)) {
    const wire = join(sessions, workspace, sessionId, 'agents', 'main', 'wire.jsonl');
    const text = await readFile(wire, 'utf8').catch(() => undefined);
    if (text !== undefined) return text.split('\n').filter(line => line !== '').map(line => (JSON.parse(line) as { type: string }).type);
  }
  throw new Error(`No main agent wire for ${sessionId} under ${sessions}`);
}

test(':wait reports a finished turn only after the session wrote it to disk, even when the disk is slow', { timeout: 30_000 }, async ({ kap, model }) => {
  const storage = kap.server.core.accessor.get(IFileSystemStorageService);
  const append = storage.append.bind(storage);
  storage.append = async (scope, key, data, options) => {
    if (new TextDecoder().decode(data).includes('"type":"turn.ended"')) await slowDisk(SLOW_WRITE_MS);
    return append(scope, key, data, options);
  };
  model.script(say('Saved answer.'));
  const session = await kap.createSession();
  await kap.prompt(session.id, 'Save this turn.');
  const idle = await kap.waitIdle(session.id);
  expect(idle.activity).toBe('idle');
  expect(await wireRecordTypes(kap.home.dataDir, session.id)).toContain('turn.ended');
});
