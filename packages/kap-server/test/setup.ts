import { isolateProcessEnv } from '@moonshot-ai/testkit/fixtures';
import { useNetworkGuard } from '@moonshot-ai/testkit/vitest';

isolateProcessEnv();
useNetworkGuard();
