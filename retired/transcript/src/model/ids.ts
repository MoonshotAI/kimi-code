/**
 * Identifier vocabulary for the transcript model.
 *
 * All ids are strings. Turn ids are natural keys (`t<ordinal>`) carried over
 * from the engine's per-agent monotonic turn counter, so pages can be keyed by
 * turn without an index lookup. Step ids nest under a turn (`t3.2`), frame ids
 * under a step (`t3.2.f4`) unless the frame has its own engine-level key
 * (tool-call frames use the tool-call id) — keep ids stable across upserts so
 * L2 ops stay idempotent. Global entities (tasks, interactions, attachments,
 * todos) carry their own engine/stable ids.
 */

export type TurnId = string;
export type StepId = string;
export type FrameId = string;
export type MarkerId = string;
export type TaskRefId = string;
export type TaskId = string;
export type AgentId = string;
export type InteractionId = string;
export type AttachmentId = string;
export type TodoId = string;
export type PromptId = string;
export type ItemId = string;

export function turnId(ordinal: number): TurnId {
  return `t${ordinal}`;
}

export function stepId(turn: TurnId, ordinal: number): StepId {
  return `${turn}.${ordinal}`;
}

export function frameId(step: StepId, ordinal: number): FrameId {
  return `${step}.f${ordinal}`;
}

/** Compare turn ids by their embedded ordinal (`t2` < `t10`). */
export function compareTurnIds(a: TurnId, b: TurnId): number {
  return turnOrdinal(a) - turnOrdinal(b);
}

export function turnOrdinal(id: TurnId): number {
  const n = Number(id.slice(1));
  return Number.isFinite(n) ? n : 0;
}
