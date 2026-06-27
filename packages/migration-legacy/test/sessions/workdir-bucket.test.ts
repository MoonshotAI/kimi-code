import { describe, expect, it } from 'vitest';
import { computeWorkdirBucket, oldMd5BucketName } from '../../src/sessions/workdir-bucket.js';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'pathe';

/**
 * Reference re-implementation of kimi-core `encodeWorkDirKey` +
 * `slugifyWorkDirName` (packages/kimi-core/src/harness/session-manager/
 * workdir-key.ts + utils/workdir-slug.ts). Kept inline because those
 * functions are not part of kimi-core's public export surface. The migrator's
 * `computeWorkdirBucket` MUST stay byte-identical to this — the session picker
 * locates migrated sessions via `readdir(encodeWorkDirKey(...))`.
 */
function referenceEncodeWorkDirKey(workDir: string): string {
  const normalized = resolve(workDir);
  const name = basename(normalized);
  const slug0 = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 40)
    .replaceAll(/^-+|-+$/g, '');
  const slug = slug0 === '' || slug0 === '.' || slug0 === '..' ? 'workspace' : slug0;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${slug}_${hash}`;
}

describe('computeWorkdirBucket', () => {
  it('produces wd_<slug>_<sha256-12> for a normal path', () => {
    const workDir = '/Users/me/Developer/proj';
    const bucket = computeWorkdirBucket(workDir);
    expect(bucket).toMatch(/^wd_proj_[0-9a-f]{12}$/);
    // The bucket hashes the platform-resolved absolute path so different
    // hosts don't collide. Match that here.
    const expected = createHash('sha256').update(resolve(workDir)).digest('hex').slice(0, 12);
    expect(bucket).toBe(`wd_proj_${expected}`);
  });

  it('slugifies basenames with special characters', () => {
    const bucket = computeWorkdirBucket('/Users/me/Some Folder With Spaces');
    expect(bucket).toMatch(/^wd_some-folder-with-spaces_[0-9a-f]{12}$/);
  });

  it('handles unicode basename by replacing with a stable safe form', () => {
    const bucket = computeWorkdirBucket('/Users/me/项目');
    // We don't require any specific slug, but we require it's bucket-safe
    expect(bucket).toMatch(/^wd_[a-z0-9-]+_[0-9a-f]{12}$/i);
  });
});

describe('computeWorkdirBucket matches kimi-core encodeWorkDirKey', () => {
  it.each([
    '/Users/example/proj',
    '/Users/example/proj/', // trailing slash
    '/Users/example/proj/../proj', // .. segment
    '/Users/example//proj', // double slash
    '/Users/example/proj/.', // trailing dot
    '/Users/example/Some Folder', // spaces
  ])('byte-identical for %s', (p) => {
    expect(computeWorkdirBucket(p)).toBe(referenceEncodeWorkDirKey(p));
  });
});

describe('oldMd5BucketName', () => {
  it('returns the md5 hex of the workdir path', () => {
    const expected = createHash('md5').update('/Users/me/proj').digest('hex');
    expect(oldMd5BucketName('/Users/me/proj')).toBe(expected);
  });
});
