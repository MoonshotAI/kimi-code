import { createKimiHarness, type PermissionMode } from '@moonshot-ai/kimi-code-sdk';

import {
  smokeIdentityFromEnv,
  createConfiguredSession,
  startPromptAndWaitForDelta,
} from './runtime-smoke-helpers';

async function main(): Promise<void> {
  const harness = createKimiHarness({ identity: smokeIdentityFromEnv() });
  const mode: PermissionMode = 'yolo';

  try {
    const session = await createConfiguredSession(harness);
    await session.setPermission(mode);
    const stream = await startPromptAndWaitForDelta(
      session,
      'Reply with one sentence after permission mode is set.',
    );
    const ended = await stream.ended;
    if (ended.type !== 'turn.ended' || ended.reason !== 'completed') {
      throw new Error(`Expected completed turn, got ${ended.type}`);
    }

    process.stdout.write(`setPermission smoke passed: ${mode}\n`);
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
