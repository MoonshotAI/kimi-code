import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import {
  smokeIdentityFromEnv,
  createConfiguredSession,
  startPromptAndWaitForDelta,
} from './runtime-smoke-helpers';

async function main(): Promise<void> {
  const harness = createKimiHarness({ identity: smokeIdentityFromEnv() });

  try {
    const session = await createConfiguredSession(harness);
    await session.setThinking('high');
    const stream = await startPromptAndWaitForDelta(
      session,
      'Reply with a concise summary of runtime smoke testing.',
    );
    const ended = await stream.ended;
    if (ended.type !== 'turn.ended' || ended.reason !== 'completed') {
      throw new Error(`Expected completed turn, got ${ended.type}`);
    }

    process.stdout.write(`setThinking smoke passed: ${session.id}\n`);
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
