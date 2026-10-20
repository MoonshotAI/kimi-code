import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { smokeIdentityFromEnv } from './runtime-smoke-helpers';

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-harness-list-home-'));
  const workDirA = await mkdtemp(join(tmpdir(), 'kimi-harness-list-work-a-'));
  const workDirB = await mkdtemp(join(tmpdir(), 'kimi-harness-list-work-b-'));
  const harness = createKimiHarness({
    identity: smokeIdentityFromEnv(),
    homeDir,
  });

  try {
    await harness.createSession({ id: 'ses_list_a', workDir: workDirA });
    await delay(2);
    await harness.createSession({ id: 'ses_list_b', workDir: workDirB });
    await delay(2);
    const sessionC = await harness.createSession({ id: 'ses_list_c', workDir: workDirA });
    const sessionCSummary = (await harness.listSessions({ workDir: workDirA })).find(
      (item) => item.id === sessionC.id,
    );
    if (sessionCSummary === undefined) {
      throw new Error('created session was not returned by listSessions');
    }
    await writeFile(
      join(sessionCSummary.sessionDir, 'state.json'),
      `${JSON.stringify({ session_id: sessionC.id, title: 'base title' }, null, 2)}\n`,
      'utf-8',
    );
    await delay(2);
    await harness.renameSession({
      id: sessionC.id,
      title: 'list-smoke-session',
    });

    const workDirASessions = await harness.listSessions({ workDir: workDirA });
    const workDirBSessions = await harness.listSessions({ workDir: workDirB });

    if (workDirASessions.length !== 2) {
      throw new Error(`expected 2 workDirA sessions, got ${String(workDirASessions.length)}`);
    }
    if (workDirBSessions.length !== 1) {
      throw new Error(`expected 1 workDirB session, got ${String(workDirBSessions.length)}`);
    }
    const firstA = workDirASessions[0];
    if (firstA === undefined || firstA.id !== sessionC.id) {
      throw new Error('expected renamed session to be first for workDirA');
    }
    if (firstA.title !== 'list-smoke-session') {
      throw new Error('expected renamed session title in list output');
    }
    if (workDirBSessions[0]?.id !== 'ses_list_b') {
      throw new Error('expected workDirB filter to exclude workDirA sessions');
    }

    process.stdout.write(`workDirA: ${workDirASessions.length}\n`);
    process.stdout.write(`workDirB: ${workDirBSessions.length}\n`);
    process.stdout.write(`first: ${firstA.id}\n`);
    process.stdout.write(`renamed: ${firstA.title ?? '<none>'}\n`);
    process.stdout.write('ok\n');
  } finally {
    await harness.close();
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
