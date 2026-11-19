import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {} }));

import { WindowsLidState, withWindowsLidLock } from '../../../src/main/system/windows-lid-state';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
let directory: string;
let file: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'lid-state-')); file = join(directory, 'lid.json'); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('shared Windows lid ownership', () => {
  it('retains the first original until the last installation releases the plan', () => {
    new WindowsLidState(file, 'stable').claim(A, { ac: 1, dc: 2 });
    new WindowsLidState(file, 'canary').claim(A, { ac: 0, dc: 0 });
    new WindowsLidState(file, 'preview').claim(A, { ac: 0, dc: 0 });
    const stable = new WindowsLidState(file, 'stable');
    expect(stable.restorable()).toEqual({});
    stable.release();
    const canary = new WindowsLidState(file, 'canary');
    expect(canary.restorable()).toEqual({});
    canary.release();
    const preview = new WindowsLidState(file, 'preview');
    expect(preview.restorable()).toEqual({ [A]: { ac: 1, dc: 2 } });
    preview.release();
    expect(new WindowsLidState(file, 'preview').owned()).toEqual({});
  });

  it('keeps ownership per plan, and repeated enable and restart are idempotent', () => {
    new WindowsLidState(file, 'stable').claim(A, { ac: 1, dc: 2 });
    new WindowsLidState(file, 'stable').claim(A, { ac: 0, dc: 0 });
    new WindowsLidState(file, 'stable').claim(B, { ac: 2, dc: 3 });
    new WindowsLidState(file, 'canary').claim(B, { ac: 0, dc: 0 });
    expect(new WindowsLidState(file, 'stable').restorable()).toEqual({ [A]: { ac: 1, dc: 2 } });
    new WindowsLidState(file, 'stable').release();
    expect(new WindowsLidState(file, 'canary').restorable()).toEqual({ [B]: { ac: 2, dc: 3 } });
  });

  it('migrates matching legacy backups without losing the first original', () => {
    const state = new WindowsLidState(file, 'stable');
    state.migrate({ [A]: { ac: 1, dc: 2 } });
    state.migrate({ [A]: { ac: 1, dc: 2 } });
    new WindowsLidState(file, 'canary').migrate({ [A]: { ac: 1, dc: 2 } });
    const reopened = new WindowsLidState(file, 'stable');
    reopened.claim(B, { ac: 2, dc: 3 });
    expect(reopened.owned()[A]).toEqual({ ac: 1, dc: 2 });
    expect(reopened.restorable()).toEqual({ [B]: { ac: 2, dc: 3 } });
  });

  it('rejects conflicting migration without changing the shared file', () => {
    new WindowsLidState(file, 'stable').claim(A, { ac: 1, dc: 2 });
    const before = readFileSync(file, 'utf8');
    expect(() => new WindowsLidState(file, 'canary').migrate({ [B]: { ac: 2, dc: 3 }, [A]: { ac: 0, dc: 0 } })).toThrow('Conflicting');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('retains durable ownership when restoring fails and permits a completed release retry', () => {
    new WindowsLidState(file, 'stable').claim(A, { ac: 1, dc: 2 });
    expect(new WindowsLidState(file, 'stable').restorable()).toEqual({ [A]: { ac: 1, dc: 2 } });
    new WindowsLidState(file, 'stable').release();
    expect(new WindowsLidState(file, 'stable').wasReleased()).toBe(true);
    new WindowsLidState(file, 'stable').claim(A, { ac: 2, dc: 3 });
    expect(new WindowsLidState(file, 'stable').wasReleased()).toBe(false);
  });

  it.each(['{', 'null', '{"version":1,"plans":{},"released":null}'])('refuses corrupt shared state: %s', (content) => {
    writeFileSync(file, content);
    expect(() => new WindowsLidState(file, 'stable')).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  it.runIf(process.platform === 'win32')('serializes real PowerShell mutex holders and releases after failure', async () => {
    let active = 0;
    let maximum = 0;
    await Promise.all(['stable', 'canary', 'preview'].map((owner) => withWindowsLidLock(async () => {
      active++;
      maximum = Math.max(maximum, active);
      const state = new WindowsLidState(file, owner);
      await new Promise((resolve) => setTimeout(resolve, 30));
      state.claim(A, { ac: owner === 'stable' ? 1 : 0, dc: 2 });
      active--;
    }, file)));
    expect(maximum).toBe(1);
    for (const owner of ['stable', 'canary', 'preview']) expect(new WindowsLidState(file, owner).restorable()).toEqual({});
    await expect(withWindowsLidLock(async () => { throw new Error('failed operation'); }, file)).rejects.toThrow('failed operation');
    await expect(withWindowsLidLock(async () => 42, file)).resolves.toBe(42);
  }, 30_000);
});
