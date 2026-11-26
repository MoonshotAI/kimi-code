import { useNetworkGuard } from '@moonshot-ai/testkit/vitest';

Reflect.deleteProperty(process.env, 'KIMI_CODE_DEBUG');

useNetworkGuard();
