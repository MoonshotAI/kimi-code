import { isolateProcessEnv } from '@moonshot-ai/testkit/fixtures';
import { useNetworkGuard } from '@moonshot-ai/testkit/vitest';
import { afterEach } from 'vitest';

isolateProcessEnv();
useNetworkGuard();

afterEach(({ task }) => {
  if ((task.result?.retryCount ?? 0) > 0 && task.result?.state === 'pass') {
    throw new Error(
      `"${task.name}" failed and then passed on retry, so it is flaky. Find the cause instead of relying on the retry.`,
    );
  }
});
