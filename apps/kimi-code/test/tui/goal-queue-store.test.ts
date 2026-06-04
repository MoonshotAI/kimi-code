import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCodes, KimiError } from '@moonshot-ai/kimi-code-sdk';

import {
  appendGoalQueueItem,
  moveGoalQueueItem,
  readGoalQueue,
  removeGoalQueueItem,
  restoreGoalQueueItem,
  updateGoalQueueItem,
} from '#/tui/goal-queue-store';

const QUEUE_FILE = 'upcoming-goals.json';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kimi-goal-queue-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function session(sessionDir = dir) {
  return {
    id: 'session_test',
    summary: {
      sessionDir,
    },
  };
}

async function readQueueFile() {
  return JSON.parse(await readFile(join(dir, QUEUE_FILE), 'utf-8')) as unknown;
}

describe('goal queue store', () => {
  it('reads an empty queue when the file is missing', async () => {
    await expect(readGoalQueue(session())).resolves.toEqual({ goals: [] });
  });

  it('appends a trimmed upcoming goal and writes the session file', async () => {
    const snapshot = await appendGoalQueueItem(session(), { objective: '  Ship release notes  ' });

    expect(snapshot.goals).toHaveLength(1);
    expect(snapshot.goals[0]).toMatchObject({ objective: 'Ship release notes' });
    expect(snapshot.goals[0]?.id).toEqual(expect.any(String));
    expect(snapshot.goals[0]?.createdAt).toEqual(expect.any(String));
    expect(await readQueueFile()).toMatchObject({
      version: 1,
      goals: [{ objective: 'Ship release notes' }],
    });
  });

  it('preserves concurrent appends to the same session queue', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        appendGoalQueueItem(session(), { objective: `Queued goal ${index + 1}` }),
      ),
    );

    const snapshot = await readGoalQueue(session());

    expect(snapshot.goals.map((goal) => goal.objective).toSorted()).toEqual(
      Array.from({ length: 10 }, (_, index) => `Queued goal ${index + 1}`).toSorted(),
    );
  });

  it('updates an upcoming goal objective', async () => {
    const first = await appendGoalQueueItem(session(), { objective: 'Draft docs' });
    const goal = first.goals[0]!;

    const updated = await updateGoalQueueItem(session(), {
      goalId: goal.id,
      objective: '  Publish docs  ',
    });

    expect(updated.goals).toHaveLength(1);
    expect(updated.goals[0]).toMatchObject({
      id: goal.id,
      objective: 'Publish docs',
      createdAt: goal.createdAt,
    });
    expect(updated.goals[0]?.updatedAt).not.toBe(goal.updatedAt);
  });

  it('removes an upcoming goal by id', async () => {
    const first = await appendGoalQueueItem(session(), { objective: 'First' });
    const second = await appendGoalQueueItem(session(), { objective: 'Second' });

    const snapshot = await removeGoalQueueItem(session(), { goalId: first.goals[0]!.id });

    expect(snapshot.goals).toEqual([second.goals[1]]);
  });

  it('restores a removed upcoming goal at the front without duplicating it', async () => {
    const first = await appendGoalQueueItem(session(), { objective: 'First' });
    await appendGoalQueueItem(session(), { objective: 'Second' });
    const removed = first.goals[0]!;
    await removeGoalQueueItem(session(), { goalId: removed.id });

    const restored = await restoreGoalQueueItem(session(), removed);
    expect(restored.goals.map((goal) => goal.objective)).toEqual(['First', 'Second']);

    const deduped = await restoreGoalQueueItem(session(), removed);
    expect(deduped.goals.map((goal) => goal.objective)).toEqual(['First', 'Second']);
  });

  it('moves an upcoming goal up and down', async () => {
    const first = await appendGoalQueueItem(session(), { objective: 'First' });
    await appendGoalQueueItem(session(), { objective: 'Second' });
    const third = await appendGoalQueueItem(session(), { objective: 'Third' });

    const movedUp = await moveGoalQueueItem(session(), {
      goalId: third.goals[2]!.id,
      direction: 'up',
    });
    expect(movedUp.goals.map((goal) => goal.objective)).toEqual(['First', 'Third', 'Second']);

    const movedDown = await moveGoalQueueItem(session(), {
      goalId: first.goals[0]!.id,
      direction: 'down',
    });
    expect(movedDown.goals.map((goal) => goal.objective)).toEqual(['Third', 'First', 'Second']);
  });

  it('rejects empty and over-long objectives', async () => {
    await expect(appendGoalQueueItem(session(), { objective: '  ' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_EMPTY,
    });
    await expect(appendGoalQueueItem(session(), { objective: 'x'.repeat(4001) })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
    });
  });

  it('normalizes malformed queue files to an empty queue', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, QUEUE_FILE), JSON.stringify({ version: 1, goals: [{ bad: true }] }), 'utf-8');

    await expect(readGoalQueue(session())).resolves.toEqual({ goals: [] });
    await expect(readQueueFile()).resolves.toEqual({ version: 1, goals: [] });
  });

  it('throws when the session summary does not expose a session directory', async () => {
    await expect(readGoalQueue({ id: 'missing', summary: undefined })).rejects.toThrow(
      'Session missing does not expose a session directory',
    );
  });

  it('throws a goal-not-found error when the target item is missing', async () => {
    await expect(removeGoalQueueItem(session(), { goalId: 'missing' })).rejects.toBeInstanceOf(
      KimiError,
    );
    await expect(removeGoalQueueItem(session(), { goalId: 'missing' })).rejects.toMatchObject({
      code: ErrorCodes.GOAL_NOT_FOUND,
    });
  });
});
