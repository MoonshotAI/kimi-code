/**
 * The single convergence path for L1.
 *
 * `applyOperation` is a pure, copy-on-write reducer: every op maps
 * `(state, op) → { state', ... }` where `state'` shares untouched branches
 * with `state`. All ops except `append` are state-style and idempotent —
 * replaying, duplicating, or reordering them converges to the same store.
 */

import type { InteractionId, TaskId, TurnId } from '../model/ids';
import { turnOrdinal } from '../model/ids';
import type { TranscriptFrame } from '../model/frame';
import type { TranscriptItem } from '../model/item';
import type { TranscriptMeta } from '../model/meta';
import type { TranscriptTask } from '../model/task';
import type { TranscriptStep, TranscriptTurn } from '../model/turn';
import type {
  AppendOp,
  TranscriptOperation,
  TurnHeader,
  StepHeader,
} from './operation';

/** Mutable-free aggregate state behind one AgentTranscript. */
export interface AgentState {
  readonly items: readonly TranscriptItem[];
  readonly tasks: ReadonlyMap<TaskId, TranscriptTask>;
  readonly meta: TranscriptMeta;
  /** Interaction ids currently in 'pending' state (derived index). */
  readonly pendingInteractions: ReadonlySet<InteractionId>;
  /** Set by windowed resets: older turns exist beyond the loaded window. */
  readonly hasMoreOlder: boolean;
}

export const EMPTY_AGENT_STATE: AgentState = {
  items: [],
  tasks: new Map(),
  meta: {},
  pendingInteractions: new Set(),
  hasMoreOlder: false,
};

export interface ApplyResult {
  readonly state: AgentState;
  /** True when the op changed observable state. */
  readonly changed: boolean;
  /** Present when an append failed to land (offset beyond local length). */
  readonly gap?: { readonly expected: number; readonly got: number };
}

export function applyOperation(state: AgentState, op: TranscriptOperation): ApplyResult {
  switch (op.op) {
    case 'reset':
      return applyReset(state, op);
    case 'turn.upsert':
      return applyTurnUpsert(state, op.turn);
    case 'step.upsert':
      return applyStepUpsert(state, op.turnId, op.step);
    case 'frame.upsert':
      return applyFrameUpsert(state, op);
    case 'append':
      return applyAppend(state, op);
    case 'marker.upsert':
      return applyItemUpsert(state, op.item, op.item.markerId);
    case 'taskref.upsert':
      return applyItemUpsert(state, op.item, op.item.refId);
    case 'task.upsert':
      return applyTaskUpsert(state, op.task);
    case 'meta.merge':
      return applyMetaMerge(state, op.meta);
    case 'items.remove':
      return applyItemsRemove(state, op.ids);
  }
}

// ---------------------------------------------------------------- reset

function applyReset(state: AgentState, op: Extract<TranscriptOperation, { op: 'reset' }>): ApplyResult {
  const pending = new Set<InteractionId>();
  for (const item of op.snapshot.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'interaction' && frame.state === 'pending') {
          pending.add(frame.interactionId);
        }
      }
    }
  }
  return {
    state: {
      items: op.snapshot.items,
      tasks: new Map(op.snapshot.tasks.map((task) => [task.taskId, task])),
      meta: op.snapshot.meta,
      pendingInteractions: pending,
      hasMoreOlder: op.snapshot.hasMoreOlder ?? false,
    },
    changed: true,
  };
}

// ---------------------------------------------------------------- turn / step / frame

function turnHeaderToTurn(header: TurnHeader, steps: readonly TranscriptStep[]): TranscriptTurn {
  return { ...header, kind: 'turn', steps: [...steps] };
}

function skeletonTurn(turnId: TurnId): TranscriptTurn {
  return {
    kind: 'turn',
    turnId,
    ordinal: turnOrdinal(turnId),
    state: 'running',
    origin: { kind: 'other' },
    steps: [],
  };
}

function skeletonStep(stepId: string, turnId: TurnId): TranscriptStep {
  const ordinal = Number(stepId.slice(turnId.length + 1)) || 0;
  return { kind: 'step', stepId, turnId, ordinal, state: 'running', frames: [] };
}

function getTurn(state: AgentState, turnId: TurnId): TranscriptTurn | undefined {
  const item = state.items.find((entry) => entry.kind === 'turn' && entry.turnId === turnId);
  return item?.kind === 'turn' ? item : undefined;
}

/** Insert a new turn keeping turns ordered by ordinal; markers stay put. */
function insertTurn(items: readonly TranscriptItem[], turn: TranscriptTurn): readonly TranscriptItem[] {
  const next = [...items];
  let at = next.length;
  for (let i = 0; i < next.length; i += 1) {
    const entry = next[i];
    if (entry?.kind === 'turn' && entry.ordinal > turn.ordinal) {
      at = i;
      break;
    }
  }
  next.splice(at, 0, turn);
  return next;
}

function replaceTurn(
  items: readonly TranscriptItem[],
  turnId: TurnId,
  fn: (turn: TranscriptTurn) => TranscriptTurn,
): readonly TranscriptItem[] {
  return items.map((entry) =>
    entry.kind === 'turn' && entry.turnId === turnId ? fn(entry) : entry,
  );
}

function applyTurnUpsert(state: AgentState, header: TurnHeader): ApplyResult {
  const existing = getTurn(state, header.turnId);
  if (existing) {
    if (turnEquals(existing, header)) return { state, changed: false };
    return {
      state: {
        ...state,
        items: replaceTurn(state.items, header.turnId, (turn) =>
          turnHeaderToTurn(header, turn.steps),
        ),
      },
      changed: true,
    };
  }
  return {
    state: { ...state, items: insertTurn(state.items, turnHeaderToTurn(header, [])) },
    changed: true,
  };
}

function turnEquals(turn: TranscriptTurn, header: TurnHeader): boolean {
  return (
    turn.ordinal === header.ordinal &&
    turn.state === header.state &&
    turn.prompt === header.prompt &&
    turn.startedAt === header.startedAt &&
    turn.endedAt === header.endedAt &&
    turn.origin.kind === header.origin.kind &&
    turn.origin.payload === header.origin.payload &&
    turn.usage === header.usage
  );
}

function applyStepUpsert(state: AgentState, turnId: TurnId, header: StepHeader): ApplyResult {
  const turn = getTurn(state, turnId) ?? skeletonTurn(turnId);
  const stepIndex = turn.steps.findIndex((step) => step.stepId === header.stepId);
  let steps: readonly TranscriptStep[];
  let changed = true;
  if (stepIndex >= 0) {
    const current = turn.steps[stepIndex];
    if (current && stepEquals(current, header)) {
      changed = false;
      steps = turn.steps;
    } else {
      steps = turn.steps.map((step) =>
        step.stepId === header.stepId ? { ...header, kind: 'step' as const, frames: step.frames } : step,
      );
    }
  } else {
    steps = [...turn.steps, { ...header, kind: 'step' as const, frames: [] }].toSorted(
      (a, b) => a.ordinal - b.ordinal,
    );
  }
  if (!changed) return { state, changed: false };
  const nextTurn: TranscriptTurn = { ...turn, steps: [...steps] };
  const items = getTurn(state, turnId)
    ? replaceTurn(state.items, turnId, () => nextTurn)
    : insertTurn(state.items, nextTurn);
  return { state: { ...state, items }, changed: true };
}

function stepEquals(step: TranscriptStep, header: StepHeader): boolean {
  return (
    step.ordinal === header.ordinal &&
    step.state === header.state &&
    step.startedAt === header.startedAt &&
    step.endedAt === header.endedAt
  );
}

function applyFrameUpsert(
  state: AgentState,
  op: Extract<TranscriptOperation, { op: 'frame.upsert' }>,
): ApplyResult {
  const turn = getTurn(state, op.turnId) ?? skeletonTurn(op.turnId);
  const step = turn.steps.find((entry) => entry.stepId === op.stepId) ?? skeletonStep(op.stepId, op.turnId);
  const existing = step.frames.findIndex((frame) => frame.frameId === op.frame.frameId);
  let frames: readonly TranscriptFrame[];
  if (existing >= 0) {
    const current = step.frames[existing];
    if (current !== undefined && frameEquals(current, op.frame)) {
      return { state, changed: false };
    }
    frames = step.frames.map((frame) => (frame.frameId === op.frame.frameId ? op.frame : frame));
  } else {
    frames = [...step.frames, op.frame];
  }
  const nextStep: TranscriptStep = { ...step, frames: [...frames] };
  const steps = turn.steps.some((entry) => entry.stepId === op.stepId)
    ? turn.steps.map((entry) => (entry.stepId === op.stepId ? nextStep : entry))
    : [...turn.steps, nextStep].toSorted((a, b) => a.ordinal - b.ordinal);
  const nextTurn: TranscriptTurn = { ...turn, steps };
  const items = getTurn(state, op.turnId)
    ? replaceTurn(state.items, op.turnId, () => nextTurn)
    : insertTurn(state.items, nextTurn);
  return {
    state: { ...state, items, pendingInteractions: trackPending(state.pendingInteractions, op.frame) },
    changed: true,
  };
}

function frameEquals(a: TranscriptFrame, b: TranscriptFrame): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text && a.role === b.role;
  if (a.kind === 'thinking' && b.kind === 'thinking') return a.text === b.text;
  if (a.kind === 'tool' && b.kind === 'tool') {
    return (
      a.state === b.state &&
      a.output === b.output &&
      a.display === b.display &&
      a.error === b.error &&
      a.taskId === b.taskId &&
      a.approvalId === b.approvalId &&
      a.agentRefs === b.agentRefs
    );
  }
  if (a.kind === 'interaction' && b.kind === 'interaction') {
    return a.state === b.state && a.request === b.request && a.response === b.response;
  }
  if (a.kind === 'notice' && b.kind === 'notice') {
    return a.message === b.message && a.level === b.level && a.detail === b.detail;
  }
  return false;
}

function trackPending(
  pending: ReadonlySet<InteractionId>,
  frame: TranscriptFrame,
): ReadonlySet<InteractionId> {
  if (frame.kind !== 'interaction') return pending;
  if (frame.state === 'pending') {
    if (pending.has(frame.interactionId)) return pending;
    const next = new Set(pending);
    next.add(frame.interactionId);
    return next;
  }
  if (!pending.has(frame.interactionId)) return pending;
  const next = new Set(pending);
  next.delete(frame.interactionId);
  return next;
}

// ---------------------------------------------------------------- append (only non-idempotent op)

function applyAppend(state: AgentState, op: AppendOp): ApplyResult {
  if (op.target.type === 'task') return applyTaskAppend(state, op);
  const { turnId, stepId, frameId } = op.target;
  const turn = getTurn(state, turnId);
  const step = turn?.steps.find((entry) => entry.stepId === stepId);
  const frame = step?.frames.find((entry) => entry.frameId === frameId);
  if (!turn || !step || !frame || (frame.kind !== 'text' && frame.kind !== 'thinking')) {
    return { state, changed: false, gap: { expected: 0, got: op.offset } };
  }
  const merged = appendAtOffset(frame.text, op.offset, op.text);
  if (merged.gap) return { state, changed: false, gap: merged.gap };
  if (!merged.changed) return { state, changed: false };
  const nextFrame = { ...frame, text: merged.text };
  const nextStep: TranscriptStep = {
    ...step,
    frames: step.frames.map((entry) => (entry.frameId === frameId ? nextFrame : entry)),
  };
  const nextTurn: TranscriptTurn = {
    ...turn,
    steps: turn.steps.map((entry) => (entry.stepId === stepId ? nextStep : entry)),
  };
  return {
    state: { ...state, items: replaceTurn(state.items, turnId, () => nextTurn) },
    changed: true,
  };
}

function applyTaskAppend(state: AgentState, op: AppendOp): ApplyResult {
  if (op.target.type !== 'task') throw new Error('unreachable');
  const taskId = op.target.taskId;
  const task = state.tasks.get(taskId);
  const current = task?.outputTail ?? '';
  const merged = appendAtOffset(current, op.offset, op.text);
  if (merged.gap) return { state, changed: false, gap: merged.gap };
  if (!merged.changed) return { state, changed: false };
  const nextTask: TranscriptTask = task
    ? { ...task, outputTail: merged.text }
    : { taskId, kind: 'other', state: 'running', detached: false, outputTail: merged.text };
  const tasks = new Map(state.tasks);
  tasks.set(taskId, nextTask);
  return { state: { ...state, tasks }, changed: true };
}

/**
 * Offset placement, mirroring the web client's alignDelta semantics:
 * `offset > local length` is a gap (caller should re-snapshot); a chunk that
 * is already fully present is a duplicate (no change); a partially present
 * chunk is trimmed to its novel suffix.
 */
export function appendAtOffset(
  local: string,
  offset: number,
  chunk: string,
): { text: string; changed: boolean; gap?: { expected: number; got: number } } {
  if (offset > local.length) return { text: local, changed: false, gap: { expected: local.length, got: offset } };
  if (local.slice(offset, offset + chunk.length) === chunk) {
    return { text: local, changed: false };
  }
  const overlap = local.length - offset;
  const novel = overlap > 0 ? chunk.slice(overlap) : chunk;
  if (novel.length === 0) return { text: local, changed: false };
  return { text: local.slice(0, offset) + chunk, changed: true };
}

// ---------------------------------------------------------------- standalone items

function applyItemUpsert(state: AgentState, item: TranscriptItem, id: string): ApplyResult {
  const exists = state.items.some((entry) => itemIdOf(entry) === id);
  if (exists) {
    let changed = false;
    const items = state.items.map((entry) => {
      if (itemIdOf(entry) !== id) return entry;
      if (entry === item) return entry;
      changed = true;
      return item;
    });
    if (!changed) return { state, changed: false };
    return { state: { ...state, items }, changed: true };
  }
  return { state: { ...state, items: [...state.items, item] }, changed: true };
}

function itemIdOf(item: TranscriptItem): string {
  switch (item.kind) {
    case 'turn':
      return item.turnId;
    case 'marker':
      return item.markerId;
    case 'taskref':
      return item.refId;
  }
}

function applyItemsRemove(state: AgentState, ids: readonly string[]): ApplyResult {
  const drop = new Set(ids);
  const removedTurns = state.items.filter(
    (entry): entry is TranscriptTurn => entry.kind === 'turn' && drop.has(entry.turnId),
  );
  const items = state.items.filter((entry) => !drop.has(itemIdOf(entry)));
  if (items.length === state.items.length) return { state, changed: false };
  let pending = state.pendingInteractions;
  if (pending.size > 0 && removedTurns.length > 0) {
    const next = new Set(pending);
    for (const turn of removedTurns) {
      for (const step of turn.steps) {
        for (const frame of step.frames) {
          if (frame.kind === 'interaction') next.delete(frame.interactionId);
        }
      }
    }
    pending = next;
  }
  return { state: { ...state, items, pendingInteractions: pending }, changed: true };
}

// ---------------------------------------------------------------- tasks / meta

function applyTaskUpsert(state: AgentState, task: TranscriptTask): ApplyResult {
  const current = state.tasks.get(task.taskId);
  if (current && taskEquals(current, task)) return { state, changed: false };
  const tasks = new Map(state.tasks);
  tasks.set(task.taskId, task);
  return { state: { ...state, tasks }, changed: true };
}

function taskEquals(a: TranscriptTask, b: TranscriptTask): boolean {
  return (
    a.kind === b.kind &&
    a.state === b.state &&
    a.detached === b.detached &&
    a.description === b.description &&
    a.agentId === b.agentId &&
    a.outputTail === b.outputTail &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt
  );
}

function applyMetaMerge(state: AgentState, meta: TranscriptMeta): ApplyResult {
  const next: TranscriptMeta = {
    goal: meta.goal ?? state.meta.goal,
    activity: meta.activity ?? state.meta.activity,
    modes:
      meta.modes !== undefined
        ? {
            plan: meta.modes.plan ?? state.meta.modes?.plan,
            swarm: meta.modes.swarm ?? state.meta.modes?.swarm,
          }
        : state.meta.modes,
  };
  if (
    next.goal === state.meta.goal &&
    next.activity === state.meta.activity &&
    next.modes === state.meta.modes
  ) {
    return { state, changed: false };
  }
  return { state: { ...state, meta: next }, changed: true };
}
