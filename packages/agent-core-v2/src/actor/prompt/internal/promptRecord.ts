import { USER_PROMPT_ORIGIN, type ContextMessage } from '#/actor/contextMemory/types';
import type { Turn } from '#/actor/loop/internal/loop';
import type { ContentPart } from '#/kosong/contract/message';

import type {
  PromptCompletion,
  PromptHandle,
  PromptOrigin,
  PromptSnapshot,
  PromptState,
  PromptSubmitResult,
} from '../prompt';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface PromptRecord {
  readonly id: string;
  readonly userMessageId: string;
  readonly createdAt: string;
  state: PromptState;
  readonly message: ContextMessage;
  readonly launchedDeferred: Deferred<Turn | undefined>;
  readonly completionDeferred: Deferred<PromptCompletion>;
  readonly handle: PromptHandle;
}

export interface ActivePromptRecord extends PromptRecord {
  readonly turn: Turn;
}

export function createPromptRecord(id: string, message: ContextMessage): PromptRecord {
  const launchedDeferred = deferred<Turn | undefined>();
  const completionDeferred = deferred<PromptCompletion>();
  const record: PromptRecord = {
    id,
    userMessageId: id,
    createdAt: new Date().toISOString(),
    state: 'pending',
    message,
    launchedDeferred,
    completionDeferred,
    handle: {
      get id() {
        return record.id;
      },
      get userMessageId() {
        return record.userMessageId;
      },
      get createdAt() {
        return record.createdAt;
      },
      get state() {
        return record.state;
      },
      get message() {
        return record.message;
      },
      launched: launchedDeferred.promise,
      completion: completionDeferred.promise,
    },
  };
  return record;
}

export function snapshotOf(record: PromptRecord): PromptSnapshot {
  return {
    id: record.id,
    userMessageId: record.userMessageId,
    createdAt: record.createdAt,
    state: record.state,
    message: record.message,
  };
}

export function bundledSkillBlockCount(message: ContextMessage): number {
  return message.origin?.kind === 'user' ? (message.origin.skillActivations?.length ?? 0) : 0;
}

export function stripBundledSkillBlocks(message: ContextMessage): ContentPart[] {
  return message.content.slice(bundledSkillBlockCount(message));
}

export function mergeSteerMessages(records: readonly PromptRecord[]): ContextMessage {
  const skillActivations = records.flatMap((item) =>
    item.message.origin?.kind === 'user' ? (item.message.origin.skillActivations ?? []) : [],
  );
  return {
    role: 'user',
    content: [
      ...records.flatMap((item) => item.message.content.slice(0, bundledSkillBlockCount(item.message))),
      ...records.flatMap((item) => stripBundledSkillBlocks(item.message)),
    ],
    toolCalls: [],
    origin: skillActivations.length === 0 ? USER_PROMPT_ORIGIN : { kind: 'user', skillActivations },
  };
}

export function userMessageForOrigin(
  content: readonly ContentPart[],
  origin: PromptOrigin,
): ContextMessage {
  return {
    role: 'user',
    content: [...content],
    toolCalls: [],
    origin: origin.kind === 'user' ? { kind: 'user' } : undefined,
  };
}

export function submitResultOf(handle: PromptHandle, turn: Turn | undefined): PromptSubmitResult {
  const state = handle.state === 'running' || handle.state === 'steered'
    ? 'running'
    : handle.state === 'blocked' ? 'blocked' : 'queued';
  return {
    promptId: handle.id,
    createdAt: handle.createdAt,
    state,
    turnId: turn === undefined ? undefined : turn.id,
  };
}
