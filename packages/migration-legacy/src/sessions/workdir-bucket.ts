import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { slugifyWorkDirName } from '@moonshot-ai/agent-core';

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

/**
 * Compute the v2 bucket directory name `wd_<slug>_<hash12>` for a workdir
 * path. Slug rules use `slugifyWorkDirName` from `@moonshot-ai/agent-core`
 * (file: `packages/agent-core/src/utils/workdir-slug.ts`); hash and resolve
 * logic mirror `packages/agent-core/src/harness/session-manager/workdir-key.ts`.
 *
 * IMPORTANT: agent-core's `encodeWorkDirKey` runs `resolve()` on the workdir
 * before hashing/slugifying, and the session picker locates sessions purely
 * by `readdir(encodeWorkDirKey(...))` — it never consults `session_index.jsonl`.
 * We MUST apply the same `resolve()` here or migrated sessions become
 * invisible in the picker.
 */
export function computeWorkdirBucket(workdirPath: string): string {
  const normalized = resolve(workdirPath);
  const hash12 = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  const slug = slugifyWorkDirName(basename(normalized));
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash12}`;
}

/** Returns the md5 hex of the workdir path; used to reverse-look-up old buckets. */
export function oldMd5BucketName(workdirPath: string): string {
  return createHash('md5').update(workdirPath).digest('hex');
}


