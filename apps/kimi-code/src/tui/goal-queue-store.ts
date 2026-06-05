import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ErrorCodes,
  KimiError,
} from '@moonshot-ai/kimi-code-sdk';

const GOAL_QUEUE_FILE = 'upcoming-goals.json';
const GOAL_QUEUE_VERSION = 1;
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

export interface UpcomingGoal {
  readonly id: string;
  readonly objective: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GoalQueueSnapshot {
  readonly goals: readonly UpcomingGoal[];
}

export type GoalQueueMoveDirection = 'up' | 'down';

interface GoalQueueFile {
  readonly version: typeof GOAL_QUEUE_VERSION;
  readonly goals: readonly UpcomingGoal[];
}

interface GoalQueueSession {
  readonly id: string;
  readonly summary?: {
    readonly sessionDir?: string;
  };
}

const queueMutationLocks = new Map<string, Promise<void>>();

export async function readGoalQueue(session: GoalQueueSession): Promise<GoalQueueSnapshot> {
  const state = await readQueueFile(session);
  return toSnapshot(state);
}

export async function appendGoalQueueItem(
  session: GoalQueueSession,
  input: { readonly objective: string },
): Promise<GoalQueueSnapshot> {
  const objective = normalizeObjective(input.objective);
  return withQueueMutationLock(session, async () => {
    const state = await readQueueFile(session);
    const now = new Date().toISOString();
    const goal: UpcomingGoal = {
      id: randomUUID(),
      objective,
      createdAt: now,
      updatedAt: now,
    };
    const next: GoalQueueFile = { version: GOAL_QUEUE_VERSION, goals: [...state.goals, goal] };
    await writeQueueFile(session, next);
    return toSnapshot(next);
  });
}

export async function updateGoalQueueItem(
  session: GoalQueueSession,
  input: { readonly goalId: string; readonly objective: string },
): Promise<GoalQueueSnapshot> {
  const objective = normalizeObjective(input.objective);
  return withQueueMutationLock(session, async () => {
    const state = await readQueueFile(session);
    const index = findGoalIndex(state, input.goalId);
    const current = state.goals[index]!;
    const updatedAt = timestampAfter(current.updatedAt);
    const goals = state.goals.map((goal, goalIndex) =>
      goalIndex === index ? { ...goal, objective, updatedAt } : goal,
    );
    const next: GoalQueueFile = { version: GOAL_QUEUE_VERSION, goals };
    await writeQueueFile(session, next);
    return toSnapshot(next);
  });
}

export async function removeGoalQueueItem(
  session: GoalQueueSession,
  input: { readonly goalId: string },
): Promise<GoalQueueSnapshot> {
  return withQueueMutationLock(session, async () => {
    const state = await readQueueFile(session);
    const index = findGoalIndex(state, input.goalId);
    const goals = state.goals.filter((_, goalIndex) => goalIndex !== index);
    const next: GoalQueueFile = { version: GOAL_QUEUE_VERSION, goals };
    await writeQueueFile(session, next);
    return toSnapshot(next);
  });
}

export async function restoreGoalQueueItem(
  session: GoalQueueSession,
  goal: UpcomingGoal,
): Promise<GoalQueueSnapshot> {
  return withQueueMutationLock(session, async () => {
    const state = await readQueueFile(session);
    if (state.goals.some((item) => item.id === goal.id)) {
      return toSnapshot(state);
    }
    const next: GoalQueueFile = { version: GOAL_QUEUE_VERSION, goals: [goal, ...state.goals] };
    await writeQueueFile(session, next);
    return toSnapshot(next);
  });
}

export async function moveGoalQueueItem(
  session: GoalQueueSession,
  input: { readonly goalId: string; readonly direction: GoalQueueMoveDirection },
): Promise<GoalQueueSnapshot> {
  return withQueueMutationLock(session, async () => {
    const state = await readQueueFile(session);
    const index = findGoalIndex(state, input.goalId);
    const targetIndex = input.direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= state.goals.length) {
      return toSnapshot(state);
    }
    const goals = [...state.goals];
    const [goal] = goals.splice(index, 1);
    goals.splice(targetIndex, 0, goal!);
    const next: GoalQueueFile = { version: GOAL_QUEUE_VERSION, goals };
    await writeQueueFile(session, next);
    return toSnapshot(next);
  });
}

function goalQueuePath(session: GoalQueueSession): string {
  const sessionDir = session.summary?.sessionDir;
  if (sessionDir === undefined || sessionDir.trim().length === 0) {
    throw new Error(`Session ${session.id} does not expose a session directory`);
  }
  return join(sessionDir, GOAL_QUEUE_FILE);
}

async function readQueueFile(session: GoalQueueSession): Promise<GoalQueueFile> {
  const filePath = goalQueuePath(session);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return emptyQueueFile();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const empty = emptyQueueFile();
    await writeQueueFile(session, empty);
    return empty;
  }

  if (!isGoalQueueFile(parsed)) {
    const empty = emptyQueueFile();
    await writeQueueFile(session, empty);
    return empty;
  }

  return parsed;
}

async function writeQueueFile(session: GoalQueueSession, file: GoalQueueFile): Promise<void> {
  const filePath = goalQueuePath(session);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
}

async function withQueueMutationLock<T>(
  session: GoalQueueSession,
  work: () => Promise<T>,
): Promise<T> {
  const filePath = goalQueuePath(session);
  const previous = queueMutationLocks.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const lock = run.then(
    () => undefined,
    () => undefined,
  );
  queueMutationLocks.set(filePath, lock);
  try {
    return await run;
  } finally {
    if (queueMutationLocks.get(filePath) === lock) {
      queueMutationLocks.delete(filePath);
    }
  }
}

function emptyQueueFile(): GoalQueueFile {
  return { version: GOAL_QUEUE_VERSION, goals: [] };
}

function toSnapshot(file: GoalQueueFile): GoalQueueSnapshot {
  return { goals: file.goals };
}

function normalizeObjective(value: string): string {
  const objective = value.trim();
  if (objective.length === 0) {
    throw new KimiError(ErrorCodes.GOAL_OBJECTIVE_EMPTY, 'Goal objective cannot be empty');
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    throw new KimiError(
      ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
      `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters`,
    );
  }
  return objective;
}

function findGoalIndex(file: GoalQueueFile, goalId: string): number {
  const index = file.goals.findIndex((goal) => goal.id === goalId);
  if (index === -1) {
    throw new KimiError(ErrorCodes.GOAL_NOT_FOUND, 'No queued goal found');
  }
  return index;
}

function isGoalQueueFile(value: unknown): value is GoalQueueFile {
  if (!isRecord(value)) return false;
  return (
    value['version'] === GOAL_QUEUE_VERSION &&
    Array.isArray(value['goals']) &&
    value['goals'].every(isUpcomingGoal)
  );
}

function isUpcomingGoal(value: unknown): value is UpcomingGoal {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value['id']) &&
    isNonEmptyString(value['objective']) &&
    isNonEmptyString(value['createdAt']) &&
    isNonEmptyString(value['updatedAt'])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function timestampAfter(previous: string): string {
  const now = new Date();
  const previousMs = Date.parse(previous);
  if (Number.isFinite(previousMs) && now.getTime() <= previousMs) {
    return new Date(previousMs + 1).toISOString();
  }
  return now.toISOString();
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error['code'] === code;
}
