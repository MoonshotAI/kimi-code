import { isolateProcessEnv } from '@moonshot-ai/testkit/fixtures';
import { useNetworkGuard } from '@moonshot-ai/testkit/vitest';
import { afterEach, type TestContext } from 'vitest';

isolateProcessEnv();
useNetworkGuard();

afterEach((context: TestContext) => {
  const result = context.task.result;
  if ((result?.retryCount ?? 0) > 0 && result?.state === 'pass') {
    throw new Error(
      `"${context.task.name}" failed and then passed on retry, so it is flaky. Find the cause instead of relying on the retry.`,
    );
  }
});
