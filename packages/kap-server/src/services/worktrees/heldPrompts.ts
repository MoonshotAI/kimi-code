import type { Scope } from '@moonshot-ai/agent-core-v2';

import { ErrorCode } from '../../protocol/error-codes';
import type { WorktreeHeldPrompt } from '../../protocol/worktree';
import { mapError } from '../../transport/errors';
import type { ServerLogger } from '../pinoLoggerService';
import {
  withoutHeldPrompt,
  worktreeHoldsPrompts,
  writeStoredWorktree,
  type HeldPromptRequest,
  type StoredSessionWorktree,
} from './sessionWorktreeState';
import { stateInvalid } from './worktreeError';

export type HeldPromptDispatcher = (
  sessionId: string,
  held: WorktreeHeldPrompt,
  request: HeldPromptRequest,
) => Promise<void>;

export async function holdPromptForWorktree(
  core: Scope,
  sessionId: string,
  held: WorktreeHeldPrompt,
  request: HeldPromptRequest,
): Promise<boolean> {
  const result: { outcome: 'held' | 'busy' | 'free' } = { outcome: 'free' };
  await writeStoredWorktree(
    core,
    sessionId,
    (current) => {
      if (current === undefined) return undefined;
      if (!worktreeHoldsPrompts(current)) {
        return current.held_prompt?.failure === undefined ? undefined : withoutHeldPrompt(current);
      }
      if (current.held_prompt !== undefined && current.held_prompt.failure === undefined) {
        result.outcome = current.held_prompt.prompt_id === held.prompt_id ? 'held' : 'busy';
        return undefined;
      }
      result.outcome = 'held';
      return { ...current, held_prompt: held, held_request: request };
    },
    { held: 'replace' },
  );
  if (result.outcome === 'busy') {
    throw stateInvalid('another prompt is already waiting for this session\'s worktree setup');
  }
  return result.outcome === 'held';
}

const sendingHeldPrompts = new Map<string, Promise<void>>();

function sendingKey(sessionId: string, promptId: string): string {
  return `${sessionId}\n${promptId}`;
}

export async function withdrawHeldPrompt(core: Scope, sessionId: string, promptId: string): Promise<boolean> {
  const result: { withdrawn: boolean; sending?: Promise<void> } = { withdrawn: false };
  const withdraw = (current: StoredSessionWorktree | undefined): StoredSessionWorktree | undefined => {
    result.sending = sendingHeldPrompts.get(sendingKey(sessionId, promptId));
    if (result.sending !== undefined || current?.held_prompt?.prompt_id !== promptId) return undefined;
    result.withdrawn = true;
    return withoutHeldPrompt(current);
  };
  await writeStoredWorktree(core, sessionId, withdraw, { held: 'replace' });
  if (result.sending === undefined) return result.withdrawn;
  await result.sending;
  result.sending = undefined;
  await writeStoredWorktree(core, sessionId, withdraw, { held: 'replace' });
  return result.withdrawn;
}

export async function failInterruptedHeld(core: Scope, sessionId: string): Promise<void> {
  await writeStoredWorktree(
    core,
    sessionId,
    (current) => {
      if (current?.held_prompt === undefined || current.held_prompt.failure !== undefined) return undefined;
      if (worktreeHoldsPrompts(current)) return undefined;
      return {
        ...current,
        held_prompt: {
          ...current.held_prompt,
          failure: {
            code: ErrorCode.INTERNAL_ERROR,
            msg: 'the server stopped before this prompt could be sent; send it again',
          },
        },
      };
    },
    { held: 'replace' },
  );
}

export class HeldPromptRelease {
  private readonly releasing = new Map<string, Promise<void>>();

  constructor(
    private readonly core: Scope,
    private readonly dispatch: HeldPromptDispatcher | undefined,
    private readonly logger: Pick<ServerLogger, 'warn'> | undefined,
  ) {}

  release(sessionId: string): Promise<void> {
    const dispatch = this.dispatch;
    if (dispatch === undefined) return Promise.resolve();
    const running = this.releasing.get(sessionId);
    if (running !== undefined) return running;
    const release = this.send(sessionId, dispatch)
      .catch((error: unknown) => {
        this.logger?.warn(
          { sessionId, err: error instanceof Error ? error.message : String(error) },
          'held prompt could not be released',
        );
      })
      .finally(() => {
        if (this.releasing.get(sessionId) === release) this.releasing.delete(sessionId);
      });
    this.releasing.set(sessionId, release);
    return release;
  }

  async settled(): Promise<void> {
    await Promise.all(this.releasing.values());
  }

  private async send(sessionId: string, dispatch: HeldPromptDispatcher): Promise<void> {
    let held: WorktreeHeldPrompt | undefined;
    let request: HeldPromptRequest | undefined;
    let settle = (): void => {};
    await writeStoredWorktree(this.core, sessionId, (current) => {
      if (current === undefined || worktreeHoldsPrompts(current)) return undefined;
      if (current.held_prompt === undefined || current.held_prompt.failure !== undefined) return undefined;
      if (sendingHeldPrompts.has(sendingKey(sessionId, current.held_prompt.prompt_id))) return undefined;
      held = current.held_prompt;
      request = current.held_request;
      sendingHeldPrompts.set(
        sendingKey(sessionId, held.prompt_id),
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
      return undefined;
    });
    if (held === undefined) return;
    const promptId = held.prompt_id;
    let failure: WorktreeHeldPrompt['failure'];
    try {
      if (request === undefined) throw new Error('the held prompt has no stored request');
      await dispatch(sessionId, held, request);
    } catch (error) {
      const envelope = mapError(error, '');
      failure = { code: envelope.code, msg: envelope.msg };
    }
    try {
      await this.settleSent(sessionId, promptId, failure);
    } finally {
      sendingHeldPrompts.delete(sendingKey(sessionId, promptId));
      settle();
    }
  }

  private async settleSent(
    sessionId: string,
    promptId: string,
    failure: WorktreeHeldPrompt['failure'],
  ): Promise<void> {
    await writeStoredWorktree(
      this.core,
      sessionId,
      (current) => {
        if (current?.held_prompt?.prompt_id !== promptId) return undefined;
        return failure === undefined
          ? withoutHeldPrompt(current)
          : { ...current, held_prompt: { ...current.held_prompt, failure } };
      },
      { held: 'replace' },
    );
  }
}
