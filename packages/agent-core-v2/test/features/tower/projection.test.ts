import { appendFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TOWER_ACTIVITY_FEED_KINDS,
  TOWER_ACTIVITY_FEED_LIMIT,
  TOWER_NOTE_PREVIEW_MAX,
  TOWER_PROJECTION_RECENT_CLOSED_LIMIT,
  parseTowerActivityLine,
  readTowerLogFrom,
  readTowerLogTail,
  readTowerProjection,
  watchTower,
} from '../../../src/features/tower/projection/index';
import type { TowerWatchHint } from '../../../src/features/tower/projection/index';
import type {
  TowerMission,
  TowerRosterEntry,
  TowerState,
} from '../../../src/features/tower/protocol/index';

let root: string;
let disposers: Array<() => void>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tower-projection-test-'));
  disposers = [];
});

afterEach(async () => {
  for (const dispose of disposers) dispose();
  disposers = [];
  await rm(root, { recursive: true, force: true });
});

function missionFixture(partial: Partial<TowerMission> & Pick<TowerMission, 'id'>): TowerMission {
  return {
    title: `Mission ${partial.id}`,
    slug: `mission-${partial.id.toLowerCase()}`,
    kind: 'build',
    scope: ['src/x/**'],
    branch: `feat/${partial.id.toLowerCase()}`,
    worktree: `wt-${partial.id.toLowerCase()}`,
    deps: [],
    status: 'planned',
    tasks: [],
    notes: [],
    blockers: [],
    ...partial,
  };
}

function rosterFixture(
  partial: Partial<TowerRosterEntry> & Pick<TowerRosterEntry, 'name' | 'kind'>,
): TowerRosterEntry {
  return {
    agentId: `agent-${partial.name}`,
    spawnedAt: '2026-11-08T00:00:00.000Z',
    ...partial,
  };
}

function stateFixture(partial: Partial<Omit<TowerState, 'version'>> = {}): TowerState {
  return {
    version: 1,
    base: 'main',
    mode: 'branch',
    createdAt: '2026-11-08T00:00:00.000Z',
    roster: { agents: [] },
    missions: [],
    ...partial,
  };
}

function statePath(): string {
  return join(root, '.tower/comms/state.json');
}

function logPath(): string {
  return join(root, '.tower/comms/log/activity.log');
}

async function writeState(state: TowerState): Promise<void> {
  await mkdir(join(root, '.tower/comms'), { recursive: true });
  await writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}

async function writeActivityLog(lines: readonly string[]): Promise<string> {
  const content = lines.map((line) => `${line}\n`).join('');
  await mkdir(join(root, '.tower/comms/log'), { recursive: true });
  await writeFile(logPath(), content);
  return content;
}

async function writeActivityLogRaw(content: string): Promise<void> {
  await mkdir(join(root, '.tower/comms/log'), { recursive: true });
  await writeFile(logPath(), content);
}

function logLine(
  at: string,
  actor: string,
  verb: string,
  fields: Readonly<Record<string, string | number>> = {},
): string {
  const kv = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  return `${at} ${actor} ${verb}${kv.length > 0 ? ` ${kv}` : ''}`;
}

function timestamp(minute: number): string {
  return new Date(Date.UTC(2026, 10, 8, 0, minute)).toISOString();
}

function startWatch(onChange: (hint: TowerWatchHint) => void, debounceMs = 20): () => void {
  const dispose = watchTower(root, onChange, debounceMs);
  disposers.push(dispose);
  return dispose;
}

describe('readTowerProjection status', () => {
  it('reports uninitialized when the repository has no tower state at all', async () => {
    const projection = await readTowerProjection(root);

    expect(projection).toMatchObject({
      status: 'uninitialized',
      hasContent: false,
      missionCounts: {
        planned: 0,
        active: 0,
        completed: 0,
        blocked: 0,
        paused: 0,
        merged: 0,
        abandoned: 0,
      },
      workersLive: 0,
      reviewersLive: 0,
      rosterTotal: 0,
      openMissions: [],
      recentClosed: [],
      events: [],
      logOffset: 0,
    });
    expect(projection.base).toBeUndefined();
    expect(projection.mode).toBeUndefined();
    expect(projection.recoveredAt).toBeUndefined();
  });

  it('reports lost when .tower survives without state.json', async () => {
    await mkdir(join(root, '.tower'));

    const projection = await readTowerProjection(root);

    expect(projection.status).toBe('lost');
    expect(projection.hasContent).toBe(false);
    expect(projection.events).toEqual([]);
    expect(projection.logOffset).toBe(0);
    expect(projection.base).toBeUndefined();
  });

  it('reports off when state.json exists without a session owner', async () => {
    await writeState(stateFixture());

    const projection = await readTowerProjection(root);

    expect(projection.status).toBe('off');
    expect(projection.base).toBe('main');
    expect(projection.mode).toBe('branch');
  });

  it('reports active when the state records a session owner', async () => {
    await writeState(stateFixture({ sessionId: 'session-a' }));

    expect((await readTowerProjection(root)).status).toBe('active');
  });

  it('passes through recoveredAt from a recovered state', async () => {
    await writeState(stateFixture({ recoveredAt: '2026-11-08T01:00:00.000Z' }));

    expect((await readTowerProjection(root)).recoveredAt).toBe('2026-11-08T01:00:00.000Z');
  });
});

describe('hasContent', () => {
  it('is false for an initialized state with no missions and no roster', async () => {
    await writeState(stateFixture());

    expect((await readTowerProjection(root)).hasContent).toBe(false);
  });

  it('is true when missions exist', async () => {
    await writeState(stateFixture({ missions: [missionFixture({ id: 'M1' })] }));

    expect((await readTowerProjection(root)).hasContent).toBe(true);
  });

  it('is true when only roster entries exist', async () => {
    await writeState(
      stateFixture({ roster: { agents: [rosterFixture({ name: 'w1', kind: 'worker' })] } }),
    );

    expect((await readTowerProjection(root)).hasContent).toBe(true);
  });
});

describe('missions', () => {
  it('splits open and closed missions, orders open ones, and summarizes tasks and notes', async () => {
    const longNote = '😀'.repeat(TOWER_NOTE_PREVIEW_MAX + 5);
    const missions = [
      missionFixture({
        id: 'M1',
        status: 'planned',
        tasks: [
          { text: 'one', done: true },
          { text: 'two', done: false },
        ],
        notes: ['first note', longNote],
        blockers: ['blocked-a', 'blocked-b'],
      }),
      missionFixture({ id: 'M2', status: 'active' }),
      missionFixture({ id: 'M3', status: 'blocked' }),
      missionFixture({ id: 'M4', status: 'completed' }),
      missionFixture({ id: 'M5', status: 'paused' }),
      missionFixture({ id: 'M6', status: 'merged' }),
      missionFixture({ id: 'M7', status: 'abandoned' }),
      missionFixture({ id: 'M8', status: 'active' }),
    ];
    await writeState(stateFixture({ missions }));

    const projection = await readTowerProjection(root);

    expect(projection.missionCounts).toEqual({
      planned: 1,
      active: 2,
      completed: 1,
      blocked: 1,
      paused: 1,
      merged: 1,
      abandoned: 1,
    });
    expect(projection.openMissions.map((mission) => mission.id)).toEqual([
      'M2',
      'M8',
      'M3',
      'M5',
      'M4',
      'M1',
    ]);
    expect(projection.recentClosed.map((mission) => mission.id)).toEqual(['M7', 'M6']);

    const first = projection.openMissions.find((mission) => mission.id === 'M1');
    expect(first).toMatchObject({
      kind: 'build',
      branch: 'feat/m1',
      scope: ['src/x/**'],
      tasksDone: 1,
      tasksTotal: 2,
      blockers: 2,
    });
    expect(first?.latestNotePreview).toBe('😀'.repeat(TOWER_NOTE_PREVIEW_MAX));
    expect(Array.from(first?.latestNotePreview ?? '')).toHaveLength(TOWER_NOTE_PREVIEW_MAX);

    const second = projection.openMissions.find((mission) => mission.id === 'M2');
    expect(second?.latestNotePreview).toBeUndefined();
    expect(second?.owner).toBeUndefined();
  });

  it('excludes dead workers and workers on closed missions while applying reviewer liveness rules', async () => {
    const missions = [
      missionFixture({ id: 'M1', status: 'merged' }),
      missionFixture({ id: 'M2', status: 'active' }),
    ];
    const roster = {
      agents: [
        rosterFixture({ name: 'w-live', kind: 'worker', missionId: 'M2' }),
        rosterFixture({ name: 'w-zombie', kind: 'worker', missionId: 'M1' }),
        rosterFixture({
          name: 'w-dead',
          kind: 'worker',
          missionId: 'M2',
          diedAt: '2026-11-08T02:00:00.000Z',
        }),
        rosterFixture({ name: 'w-unassigned', kind: 'worker' }),
        rosterFixture({ name: 'r-free', kind: 'reviewer' }),
        rosterFixture({
          name: 'r-live',
          kind: 'reviewer',
          reviewTarget: 'feat/m2',
          reviewMissionId: 'M2',
        }),
        rosterFixture({ name: 'r-zombie', kind: 'reviewer', reviewMissionId: 'M1' }),
        rosterFixture({
          name: 'r-dead',
          kind: 'reviewer',
          diedAt: '2026-11-08T02:00:00.000Z',
        }),
      ],
    };
    await writeState(stateFixture({ missions, roster }));

    const projection = await readTowerProjection(root);

    expect(projection.workersLive).toBe(1);
    expect(projection.reviewersLive).toBe(2);
    expect(projection.rosterTotal).toBe(8);
    expect(projection.openMissions.find((mission) => mission.id === 'M2')?.liveWorkers).toBe(1);
    expect(projection.openMissions.some((mission) => mission.id === 'M1')).toBe(false);
  });

  it('derives closedAt from the last matching merge and mission.update events', async () => {
    const missions = [
      missionFixture({ id: 'M1', status: 'merged', branch: 'feat/one' }),
      missionFixture({ id: 'M2', status: 'abandoned', branch: 'feat/two' }),
      missionFixture({ id: 'M3', status: 'merged', branch: 'feat/three' }),
    ];
    await writeState(stateFixture({ missions }));
    await writeActivityLog([
      logLine('2026-11-08T01:00:00.000Z', 'tower', 'merge', { branch: 'feat/one', base: 'main' }),
      logLine('2026-11-08T02:00:00.000Z', 'tower', 'mission.update', {
        id: 'M2',
        status: 'abandoned',
      }),
      logLine('2026-11-08T03:00:00.000Z', 'tower', 'merge', { branch: 'feat/one', base: 'main' }),
      logLine('2026-11-08T04:00:00.000Z', 'tower', 'merge', { branch: 'feat/other', base: 'main' }),
      logLine('2026-11-08T05:00:00.000Z', 'tower', 'mission.update', {
        id: 'M2',
        status: 'active',
      }),
    ]);

    const projection = await readTowerProjection(root);

    expect(projection.recentClosed).toEqual([
      { id: 'M1', title: 'Mission M1', status: 'merged', closedAt: '2026-11-08T03:00:00.000Z' },
      { id: 'M2', title: 'Mission M2', status: 'abandoned', closedAt: '2026-11-08T02:00:00.000Z' },
      { id: 'M3', title: 'Mission M3', status: 'merged', closedAt: undefined },
    ]);
  });

  it('caps recentClosed at 20 entries ordered by newest close time', async () => {
    const missions = Array.from({ length: 25 }, (_, index) =>
      missionFixture({ id: `M${index + 1}`, status: 'merged' }),
    );
    await writeState(stateFixture({ missions }));
    await writeActivityLog(
      missions.map((mission, index) =>
        logLine(timestamp(index), 'tower', 'merge', { branch: mission.branch }),
      ),
    );

    const projection = await readTowerProjection(root);

    expect(projection.recentClosed).toHaveLength(TOWER_PROJECTION_RECENT_CLOSED_LIMIT);
    expect(projection.recentClosed.map((mission) => mission.id)).toEqual(
      Array.from({ length: TOWER_PROJECTION_RECENT_CLOSED_LIMIT }, (_, index) => `M${25 - index}`),
    );
  });
});

describe('events feed', () => {
  it('filters chatter, keeps the last 50 feed events in chronological order, and reports the log offset', async () => {
    const lines: string[] = [];
    for (let index = 1; index <= TOWER_ACTIVITY_FEED_LIMIT + 10; index += 1) {
      lines.push(logLine(timestamp(index), 'tower', 'spawn', { name: `w${index}` }));
      lines.push(logLine(timestamp(index), 'tower', 'inbox.send', { to: 'w1' }));
      lines.push(logLine(timestamp(index), 'tower', 'worktree.remove', { rel: 'wt-1' }));
    }
    await writeState(stateFixture());
    const content = await writeActivityLog(lines);

    const projection = await readTowerProjection(root);

    expect(projection.events).toHaveLength(TOWER_ACTIVITY_FEED_LIMIT);
    expect(projection.events[0]).toMatchObject({ kind: 'spawn', fields: { name: 'w11' } });
    expect(projection.events.at(-1)).toMatchObject({ kind: 'spawn', fields: { name: 'w60' } });
    expect(projection.events.some((event) => event.kind === 'inbox.send')).toBe(false);
    expect(projection.logOffset).toBe(Buffer.byteLength(content));
  });
});

describe('parseTowerActivityLine', () => {
  it('parses a whitelisted event and its key/value fields', () => {
    const event = parseTowerActivityLine(
      '2026-11-08T04:14:02.286Z tower spawn name=worker-m1-ab kind=worker agent=agent-1 mission=M1 ref=.tower/comms/missions/M1-example.md',
    );

    expect(event).toEqual({
      at: '2026-11-08T04:14:02.286Z',
      actor: 'tower',
      kind: 'spawn',
      fields: {
        name: 'worker-m1-ab',
        kind: 'worker',
        agent: 'agent-1',
        mission: 'M1',
        ref: '.tower/comms/missions/M1-example.md',
      },
    });
  });

  it('parses dotted verbs and keeps comma-separated scope values as one field', () => {
    const event = parseTowerActivityLine(
      '2026-11-08T04:14:02.286Z tower mission.update id=M1 status=active scope=src/a/**,src/b/**',
    );

    expect(event?.kind).toBe('mission.update');
    expect(event?.fields['scope']).toBe('src/a/**,src/b/**');
  });

  it('returns undefined for inbox and worktree chatter', () => {
    expect(
      parseTowerActivityLine('2026-11-08T04:14:02.286Z tower inbox.send to=w1 subject=hello'),
    ).toBeUndefined();
    expect(
      parseTowerActivityLine('2026-11-08T04:14:02.286Z tower worktree.remove rel=wt-1'),
    ).toBeUndefined();
    expect(
      parseTowerActivityLine('2026-11-08T04:14:02.286Z tower worktree.add rel=wt-1'),
    ).toBeUndefined();
    expect(TOWER_ACTIVITY_FEED_KINDS.has('inbox.send')).toBe(false);
    expect(TOWER_ACTIVITY_FEED_KINDS.has('worktree.remove')).toBe(false);
  });

  it('returns undefined for empty, truncated, and unknown lines', () => {
    expect(parseTowerActivityLine('')).toBeUndefined();
    expect(parseTowerActivityLine('   ')).toBeUndefined();
    expect(parseTowerActivityLine('2026-11-08T04:14:02.286Z tower')).toBeUndefined();
    expect(
      parseTowerActivityLine('2026-11-08T04:14:02.286Z tower unknown.verb key=value'),
    ).toBeUndefined();
  });

  it('ignores stray tokens without an equals sign', () => {
    const event = parseTowerActivityLine(
      '2026-11-08T04:14:02.286Z tower merge branch=feat/x stray',
    );

    expect(event?.fields).toEqual({ branch: 'feat/x' });
  });

  it('accepts every verb in the feed whitelist', () => {
    const kinds = [
      'init',
      'plan',
      'spawn',
      'died',
      'revived',
      'merge',
      'merge.blocked',
      'merge.noop',
      'mission.update',
      'mission.rework',
      'review.write',
      'finding.file',
      'rebase',
      'rebase.mission',
      'adopt',
      'release',
      'teardown',
    ];
    for (const kind of kinds) {
      expect(TOWER_ACTIVITY_FEED_KINDS.has(kind)).toBe(true);
      expect(parseTowerActivityLine(`2026-11-08T04:14:02.286Z tower ${kind}`)?.kind).toBe(kind);
    }
  });
});

describe('readTowerLogFrom', () => {
  it('returns an empty slice when the activity log does not exist', async () => {
    expect(await readTowerLogFrom(root, 0)).toEqual({ offset: 0, lines: [] });
  });

  it('reads complete lines from offset zero and advances the offset in bytes', async () => {
    const content = '第一行\nsecond\n';
    await writeActivityLogRaw(content);

    const slice = await readTowerLogFrom(root, 0);

    expect(slice.lines).toEqual(['第一行', 'second']);
    expect(slice.offset).toBe(Buffer.byteLength(content));
  });

  it('continues from a previous offset', async () => {
    await writeActivityLogRaw('one\n');
    const first = await readTowerLogFrom(root, 0);
    await appendFile(logPath(), 'two\n');

    const second = await readTowerLogFrom(root, first.offset);

    expect(second).toEqual({ offset: Buffer.byteLength('one\ntwo\n'), lines: ['two'] });
  });

  it('does not consume a trailing partial line', async () => {
    await writeActivityLogRaw('one\npart');
    const first = await readTowerLogFrom(root, 0);

    expect(first).toEqual({ offset: Buffer.byteLength('one\n'), lines: ['one'] });

    await appendFile(logPath(), 'ial\n');
    const second = await readTowerLogFrom(root, first.offset);

    expect(second).toEqual({ offset: Buffer.byteLength('one\npartial\n'), lines: ['partial'] });
  });

  it('restarts from zero when the file shrank below the offset', async () => {
    await writeActivityLogRaw('one\ntwo\n');
    const first = await readTowerLogFrom(root, 0);
    await writeActivityLogRaw('new\n');

    const second = await readTowerLogFrom(root, first.offset);

    expect(second).toEqual({ offset: Buffer.byteLength('new\n'), lines: ['new'] });
  });

  it('returns no lines when no new bytes were appended', async () => {
    await writeActivityLogRaw('one\n');
    const first = await readTowerLogFrom(root, 0);

    expect(await readTowerLogFrom(root, first.offset)).toEqual({
      offset: first.offset,
      lines: [],
    });
  });
});

describe('readTowerLogTail', () => {
  it('returns an empty slice when the activity log does not exist', async () => {
    expect(await readTowerLogTail(root, 1024)).toEqual({ offset: 0, lines: [] });
  });

  it('reads a file smaller than the byte limit completely and reports its size', async () => {
    const content = 'a\nb\nc\n';
    await writeActivityLogRaw(content);

    const tail = await readTowerLogTail(root, 1024);

    expect(tail).toEqual({ offset: Buffer.byteLength(content), lines: ['a', 'b', 'c'] });
  });

  it('drops the first partial line of a byte-limited tail and reports the file size', async () => {
    const lines = Array.from(
      { length: 20 },
      (_, index) => `line-${String(index).padStart(2, '0')}-${'x'.repeat(10)}`,
    );
    const content = lines.map((line) => `${line}\n`).join('');
    const size = Buffer.byteLength(content);
    await writeActivityLogRaw(content);
    const lineBytes = Buffer.byteLength(lines[0] ?? '') + 1;
    const startLine = 5;
    const maxBytes = size - startLine * lineBytes - 3;

    const tail = await readTowerLogTail(root, maxBytes);

    expect(tail.offset).toBe(size);
    expect(tail.lines).toEqual(lines.slice(startLine + 1));
  });
});

describe('watchTower', () => {
  beforeEach(async () => {
    await mkdir(join(root, '.tower/comms/log'), { recursive: true });
    await writeFile(statePath(), '{"version":1}\n');
    await writeFile(logPath(), '');
  });

  it('reports state.json changes as stateChanged', async () => {
    const hints: TowerWatchHint[] = [];
    startWatch((hint) => hints.push(hint));

    await writeFile(statePath(), '{"version":1,"changed":true}\n');

    await vi.waitFor(() => expect(hints.some((hint) => hint.stateChanged)).toBe(true));
    expect(hints.every((hint) => !hint.logAppended)).toBe(true);
  });

  it('reports activity.log appends as logAppended', async () => {
    const hints: TowerWatchHint[] = [];
    startWatch((hint) => hints.push(hint));

    await appendFile(logPath(), 'line\n');

    await vi.waitFor(() => expect(hints.some((hint) => hint.logAppended)).toBe(true));
    expect(hints.every((hint) => !hint.stateChanged)).toBe(true);
  });

  it('merges a burst of changes into one callback with OR-ed hints', async () => {
    const hints: TowerWatchHint[] = [];
    startWatch((hint) => hints.push(hint), 50);

    appendFileSync(logPath(), 'one\n');
    writeFileSync(statePath(), '{"version":1,"changed":true}\n');

    await vi.waitFor(() => expect(hints.length).toBeGreaterThan(0));
    await delay(120);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toEqual({ stateChanged: true, logAppended: true });
  });

  it('stops delivering callbacks after dispose', async () => {
    const hints: TowerWatchHint[] = [];
    const dispose = startWatch((hint) => hints.push(hint));

    await appendFile(logPath(), 'first\n');
    await vi.waitFor(() => expect(hints.length).toBeGreaterThan(0));
    dispose();
    const seen = hints.length;

    await appendFile(logPath(), 'second\n');
    await writeFile(statePath(), '{"version":1,"changed":true}\n');
    await delay(150);

    expect(hints).toHaveLength(seen);
  });

  it('re-arms after the tower directories appear in a bare repository root', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'tower-projection-bare-'));
    const hints: TowerWatchHint[] = [];
    const dispose = watchTower(bare, (hint) => hints.push(hint), 20);
    try {
      await mkdir(join(bare, '.tower/comms/log'), { recursive: true });
      await delay(200);
      await writeFile(join(bare, '.tower/comms/state.json'), '{"version":1}\n');

      await vi.waitFor(() => expect(hints.some((hint) => hint.stateChanged)).toBe(true), {
        timeout: 3_000,
      });
    } finally {
      dispose();
      await rm(bare, { recursive: true, force: true });
    }
  });
});
