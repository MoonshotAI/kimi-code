import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXEC_FILE_TIMEOUT_MS,
  execFileUtf8,
} from '../../src/svc/exec';

describe('execFileUtf8', () => {
  it('uses a default timeout when none is provided', () => {
    expect(DEFAULT_EXEC_FILE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('returns a non-zero result when the child process times out', async () => {
    const result = await execFileUtf8(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10_000)'],
      { timeoutMs: 20 },
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(process.execPath);
  });
});
