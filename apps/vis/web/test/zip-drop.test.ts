import { describe, expect, it } from 'vitest';

import { isZipFile } from '../src/components/shared/ZipDropOverlay';

describe('isZipFile', () => {
  it('accepts a .zip extension regardless of declared type', () => {
    expect(isZipFile({ name: 'session.zip', type: '' })).toBe(true);
    expect(isZipFile({ name: 'SESSION.ZIP', type: 'application/octet-stream' })).toBe(true);
  });

  it('accepts zip MIME types even without a .zip name', () => {
    expect(isZipFile({ name: 'bundle', type: 'application/zip' })).toBe(true);
    expect(isZipFile({ name: 'bundle', type: 'application/x-zip-compressed' })).toBe(true);
  });

  it('rejects non-zip files', () => {
    expect(isZipFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
    expect(isZipFile({ name: 'image.png', type: 'image/png' })).toBe(false);
    expect(isZipFile({ name: 'archive.tar.gz', type: 'application/gzip' })).toBe(false);
  });
});
