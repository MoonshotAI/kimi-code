import { createHash } from 'node:crypto';
import { basename, resolve } from 'pathe';

import { slugifyWorkDirName } from '#/utils/workdir-slug';

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

export function normalizeWorkDir(workDir: string): string {
  return resolve(workDir);
}

export function encodeWorkDirKey(workDir: string): string {
  const normalized = normalizeWorkDir(workDir);
  const slug = slugifyWorkDirName(basename(normalized));
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}
