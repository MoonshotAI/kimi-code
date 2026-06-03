import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import {
  smokeIdentityFromEnv,
  createConfiguredSession,
  startPromptAndWaitForDelta,
} from './runtime-smoke-helpers';

const PROMPT = 'Draft a long checklist for validating a TypeScript SDK runtime.';
const STEER = 'Also include cancellation and permission-mode checks.';

async function main(): Promise<void> {
  const harness = createKimiHarness({ identity: smokeIdentityFromEnv() });

  try {
    const session = await createConfiguredSession(harness);
    const stream = await startPromptAndWaitForDelta(session, PROMPT);

    await session.steer(STEER);
    await stream.ended;

    process.stdout.write(`steer smoke passed: ${session.id}\n`);
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
