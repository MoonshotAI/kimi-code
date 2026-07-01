import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KimiCore } from '../../src/rpc/core-impl';

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'kimi-core-close-all-'));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe('KimiCore.closeAllSessions', () => {
  it('closes every live session and clears the active session map', async () => {
    const core = new KimiCore(async () => ({}) as never, { homeDir });
    const closed: string[] = [];
    core.sessions.set('sess_a', {
      close: async () => {
        closed.push('sess_a');
      },
    } as never);
    core.sessions.set('sess_b', {
      close: async () => {
        closed.push('sess_b');
      },
    } as never);

    await core.closeAllSessions();

    expect(closed.toSorted()).toEqual(['sess_a', 'sess_b']);
    expect(core.sessions.size).toBe(0);
  });

  it('continues closing later sessions and clears entries when one close fails', async () => {
    const core = new KimiCore(async () => ({}) as never, { homeDir });
    const closed: string[] = [];
    core.sessions.set('sess_bad', {
      close: async () => {
        closed.push('sess_bad');
        throw new Error('close failed');
      },
    } as never);
    core.sessions.set('sess_good', {
      close: async () => {
        closed.push('sess_good');
      },
    } as never);

    await expect(core.closeAllSessions()).rejects.toThrow(AggregateError);

    expect(closed.toSorted()).toEqual(['sess_bad', 'sess_good']);
    expect(core.sessions.size).toBe(0);
  });
});
