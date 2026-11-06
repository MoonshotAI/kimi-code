import { describe, expect, it } from 'vitest';

import { handleUsage, type UsageDeps } from '#/cli/sub/usage';

interface Captured {
  out: string;
  err: string;
  exitCode?: number;
}

function stubDeps(result: Awaited<ReturnType<UsageDeps['getManagedUsage']>>): {
  deps: UsageDeps;
  captured: Captured;
} {
  const captured: Captured = { out: '', err: '' };
  const deps: UsageDeps = {
    getManagedUsage: async () => result,
    stdout: {
      write: (chunk) => {
        captured.out += chunk;
        return true;
      },
    },
    stderr: {
      write: (chunk) => {
        captured.err += chunk;
        return true;
      },
    },
    exit: (code) => {
      captured.exitCode = code;
      throw new Error(`exit ${code}`);
    },
    close: async () => {},
  };
  return { deps, captured };
}

const quota = {
  usages: {
    limit5h: { usedRatio: 0.5, resetAt: '2026-10-24T12:00:00Z' },
    monthTotal: { usedRatio: 0.25 },
  },
  extraUsage: null,
};

describe('handleUsage', () => {
  it('prints the managed quota as JSON', async () => {
    const { deps, captured } = stubDeps({ kind: 'ok', quota });

    await handleUsage(deps);

    expect(JSON.parse(captured.out)).toEqual(quota);
    expect(captured.err).toBe('');
  });

  it('reports fetch failures on stderr and exits with code 1', async () => {
    const { deps, captured } = stubDeps({ kind: 'error', message: 'not signed in' });

    await expect(handleUsage(deps)).rejects.toThrow('exit 1');

    expect(captured.out).toBe('');
    expect(captured.err).toContain('not signed in');
    expect(captured.exitCode).toBe(1);
  });
});
