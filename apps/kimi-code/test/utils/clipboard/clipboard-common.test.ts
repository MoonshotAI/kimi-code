import { describe, expect, it } from 'vitest';

import { runCommandAsync } from '#/utils/clipboard/clipboard-common';

describe('runCommandAsync', () => {
  it('resolves with stdout for a successful command', async () => {
    const result = await runCommandAsync(process.execPath, ['-e', 'process.stdout.write("hello")']);
    expect(result.ok).toBe(true);
    expect(result.stdout.toString('utf-8')).toBe('hello');
  });

  it('resolves ok:false for a non-zero exit', async () => {
    const result = await runCommandAsync(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.ok).toBe(false);
  });

  it('does not block when the command exceeds the timeout', async () => {
    const timeoutMs = 100;
    const start = Date.now();
    // The child would idle for 30s if left running; runCommandAsync must kill
    // it and resolve well before that so a wedged helper cannot freeze launch.
    const result = await runCommandAsync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      timeoutMs,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(5000);
  });
});
