import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import {
  smokeIdentityFromEnv,
  createConfiguredSession,
  startPromptAndWaitForDelta,
} from './runtime-smoke-helpers';

const PROMPT =
  'Write a detailed multi-paragraph explanation of how cancellation should work in an SDK streaming session.';

async function main(): Promise<void> {
  const harness = createKimiHarness({ identity: smokeIdentityFromEnv() });

  try {
    const session = await createConfiguredSession(harness);
    const stream = await startPromptAndWaitForDelta(session, PROMPT);

    await session.cancel();
    const endedEvent = await stream.ended;
    if (endedEvent.type !== 'turn.ended' || endedEvent.reason !== 'cancelled') {
      throw new Error(`Expected cancelled turn, got ${endedEvent.type}`);
    }

    process.stdout.write(`cancel smoke passed: ${session.id}\n`);
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
