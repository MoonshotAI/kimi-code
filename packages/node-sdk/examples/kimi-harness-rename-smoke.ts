import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';
import type { Event } from '@moonshot-ai/kimi-code-sdk';

import { smokeIdentityFromEnv } from './runtime-smoke-helpers';

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-harness-rename-home-'));
  const workDir = await mkdtemp(join(tmpdir(), 'kimi-harness-rename-work-'));
  const harness = createKimiHarness({
    identity: smokeIdentityFromEnv(),
    homeDir,
  });

  try {
    const session = await harness.createSession({
      id: 'ses_rename_smoke',
      workDir,
      model: 'kimi-code/kimi-for-coding',
    });
    const events: Event[] = [];
    session.onEvent((event) => {
      events.push(event);
    });
    const summary = (await harness.listSessions({ workDir })).find(
      (item) => item.id === session.id,
    );
    if (summary === undefined) {
      throw new Error('created session was not returned by listSessions');
    }
    const statePath = join(summary.sessionDir, 'state.json');
    await writeFile(
      statePath,
      `${JSON.stringify({ session_id: session.id, title: 'rename base' }, null, 2)}\n`,
      'utf-8',
    );

    await harness.renameSession({
      id: session.id,
      title: 'rename-smoke-session',
    });

    const sessions = await harness.listSessions({ workDir });
    const renamed = sessions.find((item) => item.id === session.id);
    if (renamed?.title !== 'rename-smoke-session') {
      throw new Error('renamed session was not returned by listSessions');
    }

    const renamedEvent = events.find((event) => event.type === 'session.meta.updated');
    if (
      renamedEvent?.type !== 'session.meta.updated' ||
      renamedEvent.title !== 'rename-smoke-session'
    ) {
      throw new Error('active session did not receive session_meta_updated event');
    }

    const state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
    if (state['custom_title'] !== 'rename-smoke-session') {
      throw new Error('state.json did not persist custom_title');
    }

    process.stdout.write(`session: ${session.id}\n`);
    process.stdout.write(`renamed: ${renamed.title}\n`);
    process.stdout.write(`event: ${renamedEvent.type}\n`);
    process.stdout.write(`state: ${statePath}\n`);
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
