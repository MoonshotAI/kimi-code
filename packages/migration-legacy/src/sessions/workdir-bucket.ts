import { basename, resolve } from 'pathe';
import { createHash } from 'node:crypto';

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

/**
 * Compute the v2 bucket directory name `wd_<slug>_<hash12>` for a workdir
 * path. Hash function and slug rules mirror
 * `packages/kimi-core/src/utils/workdir-slug.ts` and
 * `packages/kimi-core/src/harness/session-manager/workdir-key.ts:13–18`.
 *
 * IMPORTANT: agent-core's `encodeWorkDirKey` runs `resolve()` on the workdir
 * before hashing/slugifying, and the session picker locates sessions purely
 * by `readdir(encodeWorkDirKey(...))` — it never consults `session_index.jsonl`.
 * We MUST apply the same `resolve()` here or migrated sessions become
 * invisible in the picker.
 *
 * TODO: The canonical slugifier is `slugifyWorkDirName` in
 * `@moonshot-ai/agent-core` (file: `src/utils/workdir-slug.ts`). It is not part
 * of that package's public export surface today. When/if it becomes public,
 * delete the local duplicate below and import it from agent-core directly so
 * buckets stay byte-identical between the running app and this migrator.
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

const MAX_WORKDIR_SLUG_LENGTH = 40;

/**
 * Local copy of kimi-core's `slugifyWorkDirName`. Keep byte-identical to the
 * canonical implementation in `packages/kimi-core/src/utils/workdir-slug.ts`.
 */
function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}
