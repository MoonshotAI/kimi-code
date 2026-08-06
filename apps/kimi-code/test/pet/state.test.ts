/**
 * Pet state protocol: aggregation priority, TTL expiry, done demotion,
 * overlay heartbeat liveness, and session-state file scanning.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PetSessionState } from '#/pet/state';
import {
  PET_BUBBLE_FONT_SIZE_MAX,
  PET_BUBBLE_FONT_SIZE_MIN,
  PET_DONE_DISPLAY_MS,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  PET_SETTINGS_DEFAULTS,
  aggregateSessionStates,
  isPetOverlayAlive,
  petSessionStateFile,
  rankSessionStates,
  readPetSessionStates,
  readPetSettings,
  writeJsonFileAtomicSync,
  writePetOverlayHeartbeat,
  writePetSettings,
} from '#/pet/state';

function session(partial: Partial<PetSessionState> = {}): PetSessionState {
  return {
    sessionId: 's1',
    status: 'idle',
    updatedAt: 1_000,
    ...partial,
  };
}

describe('aggregateSessionStates', () => {
  it('returns idle with zero sessions when empty', () => {
    expect(aggregateSessionStates([], 1_000)).toEqual({ status: 'idle', sessionCount: 0 });
  });

  it('drops sessions older than the TTL', () => {
    const now = 100_000;
    const stale = session({ status: 'working', updatedAt: now - 61_000 });
    expect(aggregateSessionStates([stale], now)).toEqual({ status: 'idle', sessionCount: 0 });
  });

  it('prioritizes awaiting over failed over working over done over idle', () => {
    const now = 10_000;
    const states = [
      session({ sessionId: 'a', status: 'idle', updatedAt: now }),
      session({ sessionId: 'b', status: 'done', updatedAt: now }),
      session({ sessionId: 'c', status: 'working', updatedAt: now }),
      session({ sessionId: 'd', status: 'failed', updatedAt: now }),
      session({
        sessionId: 'e',
        status: 'awaiting',
        updatedAt: now,
        statusText: '等待你的确认…',
        title: 'fix the bug',
        pid: 4321,
      }),
    ];
    const aggregated = aggregateSessionStates(states, now);
    expect(aggregated.status).toBe('awaiting');
    expect(aggregated.statusText).toBe('等待你的确认…');
    expect(aggregated.title).toBe('fix the bug');
    expect(aggregated.pid).toBe(4321);
    expect(aggregated.sessionCount).toBe(5);
  });

  it('demotes a stale done state to idle', () => {
    const now = 100_000;
    const done = session({
      status: 'done',
      statusText: '任务完成',
      updatedAt: now - PET_DONE_DISPLAY_MS - 1,
    });
    const aggregated = aggregateSessionStates([done], now);
    expect(aggregated.status).toBe('idle');
    expect(aggregated.statusText).toBeUndefined();
    expect(aggregated.sessionCount).toBe(1);
  });

  it('picks the most recently updated session within the same priority', () => {
    const now = 10_000;
    const older = session({ sessionId: 'a', status: 'working', statusText: 'Bash', updatedAt: now - 5 });
    const newer = session({ sessionId: 'b', status: 'working', statusText: 'Read', updatedAt: now });
    expect(aggregateSessionStates([older, newer], now).statusText).toBe('Read');
  });
});

describe('rankSessionStates', () => {
  it('sorts by status priority then recency and drops expired sessions', () => {
    const now = 100_000;
    const ranked = rankSessionStates(
      [
        session({ sessionId: 'expired', status: 'working', updatedAt: now - 61_000 }),
        session({ sessionId: 'work', status: 'working', updatedAt: now - 1_000 }),
        session({ sessionId: 'await', status: 'awaiting', updatedAt: now - 5_000 }),
        session({ sessionId: 'work2', status: 'working', updatedAt: now - 500 }),
      ],
      now,
    );
    expect(ranked.map((s) => s.sessionId)).toEqual(['await', 'work2', 'work']);
  });

  it('demotes a stale done state to idle in the ranking', () => {
    const now = 100_000;
    const ranked = rankSessionStates(
      [
        session({ sessionId: 'done', status: 'done', updatedAt: now - PET_DONE_DISPLAY_MS - 1 }),
        session({ sessionId: 'work', status: 'working', updatedAt: now - 59_000 }),
      ],
      now,
    );
    expect(ranked.map((s) => s.sessionId)).toEqual(['work', 'done']);
    expect(ranked[1]?.status).toBe('idle');
    expect(ranked[1]?.statusText).toBeUndefined();
  });
});

describe('pet state files', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-pet-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a session state file and scans the directory', () => {
    const state = session({ sessionId: 'sess/1', status: 'working', statusText: 'Bash: ls' });
    writeJsonFileAtomicSync(petSessionStateFile(dir, state.sessionId), state);
    const states = readPetSessionStates(dir);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ sessionId: 'sess/1', status: 'working' });
  });

  it('ignores foreign and malformed files when scanning', () => {
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    writeFileSync(join(dir, 'broken.json'), '{not json');
    writeFileSync(join(dir, 'shape.json'), JSON.stringify({ nope: true }));
    expect(readPetSessionStates(dir)).toEqual([]);
  });

  it('returns an empty list when the directory does not exist', () => {
    expect(readPetSessionStates(join(dir, 'missing'))).toEqual([]);
  });

  it('treats a fresh heartbeat from a live pid as alive', () => {
    const heartbeatFile = join(dir, 'overlay.json');
    writePetOverlayHeartbeat(heartbeatFile);
    expect(isPetOverlayAlive(heartbeatFile, Date.now())).toBe(true);
  });

  it('treats a stale or missing heartbeat as dead', () => {
    const heartbeatFile = join(dir, 'overlay.json');
    expect(isPetOverlayAlive(heartbeatFile, Date.now())).toBe(false);
    writeFileSync(
      heartbeatFile,
      JSON.stringify({ pid: process.pid, updatedAt: Date.now() - 10_000 }),
    );
    expect(isPetOverlayAlive(heartbeatFile, Date.now())).toBe(false);
  });

  it('round-trips the pet display scale with clamping', () => {
    const settingsFile = join(dir, 'settings.json');
    expect(readPetSettings(settingsFile)).toEqual(PET_SETTINGS_DEFAULTS);
    writePetSettings({ scale: 1.4 }, settingsFile);
    expect(readPetSettings(settingsFile).scale).toBe(1.4);
    writePetSettings({ scale: 99 }, settingsFile);
    expect(readPetSettings(settingsFile).scale).toBe(PET_SCALE_MAX);
    writePetSettings({ scale: 0.01 }, settingsFile);
    expect(readPetSettings(settingsFile).scale).toBe(PET_SCALE_MIN);
    writeFileSync(settingsFile, '{broken');
    expect(readPetSettings(settingsFile)).toEqual(PET_SETTINGS_DEFAULTS);
  });

  it('round-trips the bubble font size with clamping and merge-writes', () => {
    const settingsFile = join(dir, 'settings.json');
    writePetSettings({ bubbleFontSize: 15 }, settingsFile);
    expect(readPetSettings(settingsFile).bubbleFontSize).toBe(15);
    writePetSettings({ bubbleFontSize: 99 }, settingsFile);
    expect(readPetSettings(settingsFile).bubbleFontSize).toBe(PET_BUBBLE_FONT_SIZE_MAX);
    writePetSettings({ bubbleFontSize: 1 }, settingsFile);
    expect(readPetSettings(settingsFile).bubbleFontSize).toBe(PET_BUBBLE_FONT_SIZE_MIN);
    // A font-size-only write keeps a previously stored scale (merge semantics).
    writePetSettings({ scale: 1.4 }, settingsFile);
    writePetSettings({ bubbleFontSize: 12 }, settingsFile);
    expect(readPetSettings(settingsFile)).toEqual({ scale: 1.4, bubbleFontSize: 12 });
  });
});
