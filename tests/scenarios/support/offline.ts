import { appendFileSync, writeFileSync } from 'node:fs';

import { installNetworkGuard } from '@moonshot-ai/testkit/fixtures';

const log = process.env['KIMI_TEST_KAP_NETWORK_LOG'];
if (!log) throw new Error('Missing KAP test network log');
writeFileSync(log, '', { flag: 'wx' });
installNetworkGuard({ onViolation: target => appendFileSync(log, target + '\n') });
