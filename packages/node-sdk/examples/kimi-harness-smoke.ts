import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { smokeIdentityFromEnv } from './runtime-smoke-helpers';

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'kimi-harness-smoke-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-harness-home-'));

  const harness = createKimiHarness({
    identity: smokeIdentityFromEnv(),
    homeDir,
  });
  try {
    const config = await harness.getConfig();
    const model = config.defaultModel ?? 'kimi-code/kimi-for-coding';

    const session = await harness.createSession({ workDir, model });
    const created = (await harness.listSessions({ workDir })).find(
      (item) => item.id === session.id,
    );
    if (created === undefined) {
      throw new Error('created session was not returned by listSessions');
    }
    await writeFile(
      join(created.sessionDir, 'state.json'),
      `${JSON.stringify({ session_id: session.id, title: 'smoke base' }, null, 2)}\n`,
      'utf-8',
    );
    await harness.renameSession({
      id: session.id,
      title: 'kimi-harness-smoke',
    });

    const sessionDir = created.sessionDir;
    await writeFile(
      join(sessionDir, 'wire.jsonl'),
      JSON.stringify({
        type: 'cleanup_smoke',
        time: Date.now(),
      }) + '\n',
      'utf-8',
    );
    await mkdir(join(sessionDir, 'subagents'), { recursive: true });
    await writeFile(join(sessionDir, 'subagents', 'demo.txt'), 'demo\n', 'utf-8');

    const exported = await harness.exportSession({
      id: session.id,
      outputPath: join(workDir, 'session.zip'),
      version: '1.0.0-test',
    });
    process.stdout.write(`exported: ${exported.zipPath}\n`);

    const sessions = await harness.listSessions({ workDir });
    const renamed = sessions.find((item) => item.id === session.id);
    process.stdout.write(`renamed: ${renamed?.title ?? '<none>'}\n`);
    process.stdout.write(`sessions: ${sessions.length}\n`);
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
