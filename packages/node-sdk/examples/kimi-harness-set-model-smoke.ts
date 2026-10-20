import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import {
  smokeIdentityFromEnv,
  createConfiguredSession,
  startPromptAndWaitForDelta,
} from './runtime-smoke-helpers';

async function main(): Promise<void> {
  const harness = createKimiHarness({ identity: smokeIdentityFromEnv() });

  try {
    const config = await harness.getConfig();
    const model = config.defaultModel;
    if (model === undefined) {
      throw new Error('No model configured. Set default_model in config.toml.');
    }

    const session = await createConfiguredSession(harness);
    await session.setModel(model);
    const stream = await startPromptAndWaitForDelta(
      session,
      'Reply with exactly one short sentence.',
    );
    const ended = await stream.ended;
    if (ended.type !== 'turn.ended' || ended.reason !== 'completed') {
      throw new Error(`Expected completed turn, got ${ended.type}`);
    }

    process.stdout.write(`setModel smoke passed: ${(await session.getStatus()).model ?? ''}\n`);
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
