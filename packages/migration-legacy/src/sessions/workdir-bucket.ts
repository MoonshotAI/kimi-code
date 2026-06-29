import { createHash } from 'node:crypto';

import { encodeWorkDirKey } from '@moonshot-ai/agent-core/session/store';

/**
 * Bucket directory name `wd_<slug>_<hash12>` for a workdir path.
 *
 * Aliases agent-core's `encodeWorkDirKey` so the migrator and the running app
 * always produce byte-identical buckets. The session picker locates sessions
 * purely by `readdir(encodeWorkDirKey(workDir))` (it never consults
 * `session_index.jsonl`), so the two MUST stay in sync or migrated sessions
 * become invisible in the picker.
 *
 * This used to be a local re-implementation built on `node:path`'s `resolve`.
 * On Windows `node:path` yields backslash-separated paths while agent-core's
 * `encodeWorkDirKey` uses `pathe` (forward slashes on every platform), so the
 * SHA-256 inputs diverged and migrated sessions landed in a bucket the picker
 * never reads. Delegating to `encodeWorkDirKey` removes that drift for good.
 */
export const computeWorkdirBucket = encodeWorkDirKey;

/** Returns the md5 hex of the workdir path; used to reverse-look-up old buckets. */
export function oldMd5BucketName(workdirPath: string): string {
  return createHash('md5').update(workdirPath).digest('hex');
}
