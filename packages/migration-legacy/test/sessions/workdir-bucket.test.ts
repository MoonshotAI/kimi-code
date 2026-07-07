import { describe, expect, it } from 'vitest';
import { computeWorkdirBucket, oldMd5BucketName } from '../../src/sessions/workdir-bucket.js';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core/session/store';
import { createHash } from 'node:crypto';

/**
 * `computeWorkdirBucket` now aliases agent-core's `encodeWorkDirKey`, so the
 * migrator and the running app share one implementation. The `byte-identical`
 * suite below guards against regressing back to a divergent local copy.
 */

describe('computeWorkdirBucket', () => {
  it('produces wd_<slug>_<sha256-12> for a normal path', () => {
    const bucket = computeWorkdirBucket('/Users/me/Developer/proj');
    expect(bucket).toMatch(/^wd_proj_[0-9a-f]{12}$/);
    const expected = createHash('sha256').update('/Users/me/Developer/proj').digest('hex').slice(0, 12);
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
    expect(computeWorkdirBucket(p)).toBe(encodeWorkDirKey(p));
  });
});

describe('oldMd5BucketName', () => {
  it('returns the md5 hex of the workdir path', () => {
    const expected = createHash('md5').update('/Users/me/proj').digest('hex');
    expect(oldMd5BucketName('/Users/me/proj')).toBe(expected);
  });
});
