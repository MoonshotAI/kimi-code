import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { smokeIdentityFromEnv } from './runtime-smoke-helpers';

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-harness-export-home-'));
  const workDir = await mkdtemp(join(tmpdir(), 'kimi-harness-export-work-'));
  const harness = createKimiHarness({
    identity: smokeIdentityFromEnv(),
    homeDir,
  });

  const session = await harness.createSession({
    workDir,
    model: 'kimi-code/kimi-for-coding',
  });
  const summary = (await harness.listSessions({ workDir })).find((item) => item.id === session.id);
  if (summary === undefined) {
    throw new Error('created session was not returned by listSessions');
  }
  const sessionDir = summary.sessionDir;
  await writeFile(
    join(sessionDir, 'wire.jsonl'),
    JSON.stringify({
      type: 'turn_begin',
      time: Date.now(),
      user_input: 'export smoke',
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

  for (const expected of ['manifest.json', 'wire.jsonl', 'subagents/demo.txt']) {
    if (!exported.entries.includes(expected)) {
      throw new Error(`missing ${expected} from export entries`);
    }
  }

  process.stdout.write(`exported: ${exported.zipPath}\n`);
  process.stdout.write(`entries: ${exported.entries.length}\n`);
  process.stdout.write('ok\n');

  await harness.close();
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
