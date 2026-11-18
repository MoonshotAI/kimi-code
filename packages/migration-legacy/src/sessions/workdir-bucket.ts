import { createHash } from 'node:crypto';

import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';

export const computeWorkdirBucket = encodeWorkDirKey;

export function oldMd5BucketName(workdirPath: string): string {
  return createHash('md5').update(workdirPath).digest('hex');
}
