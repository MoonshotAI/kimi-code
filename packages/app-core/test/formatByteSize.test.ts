import { describe, expect, it } from 'vitest';

import { formatByteSize } from '../src/lib/formatByteSize';

describe('formatByteSize', () => {
  it('uses 1024-based units with one decimal below 100', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(1023)).toBe('1023 B');
    expect(formatByteSize(1536)).toBe('1.5 KB');
    expect(formatByteSize(24 * 1024 ** 3)).toBe('24 GB');
    expect(formatByteSize(18.64 * 1024 ** 3)).toBe('18.6 GB');
    expect(formatByteSize(460.4 * 1024 ** 3)).toBe('460 GB');
    expect(formatByteSize(1.25 * 1024 ** 4)).toBe('1.3 TB');
  });

  it('stops at petabytes and treats negative sizes as empty', () => {
    expect(formatByteSize(30 * 1024 ** 5)).toBe('30 PB');
    expect(formatByteSize(4096 * 1024 ** 5)).toBe('4096 PB');
    expect(formatByteSize(-1)).toBe('0 B');
  });
});
