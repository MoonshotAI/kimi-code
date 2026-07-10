import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTurnService, type Turn, type TurnResult } from '#/agent/turn/turn';
import { createHooks } from '#/hooks';
import type { PromptSubmission } from '@moonshot-ai/protocol';

import { IAgentPromptLegacyService } from '#/agent/promptLegacy/promptLegacy';
import { AgentPromptLegacyService } from '#/agent/promptLegacy/promptLegacyService';
import { IAuthSummaryService } from '#/app/auth/auth';
import { IEventService } from '#/app/event/event';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

interface ControlledTurn {
  readonly turn: Turn;
  readonly settle: (result: TurnResult) => void;
}

function controlledTurn(id: number): ControlledTurn {
  let settle!: (result: TurnResult) => void;
  const result = new Promise<TurnResult>((resolve) => {
    settle = resolve;
  });
  const turn: Turn = {
    id,
    signal: new AbortController().signal,
    ready: Promise.resolve(),
    result,
  };
  return { turn, settle };
}

function textBody(text: string): PromptSubmission {
  return { content: [{ type: 'text', text }] };
}

interface Harness {
  readonly service: IAgentPromptLegacyService;
  readonly turns: Turn[];
  readonly settleActive: (result: TurnResult) => void;
  readonly steered: string[];
  readonly ensureReady: ReturnType<typeof vi.fn>;
}

function createHarness(options: { readonly blockPrompt?: boolean } = {}): Harness {
  const disposables = new DisposableStore();
  onTestFinished(() => disposables.dispose());

  let nextTurnId = 0;
  let activeTurn: Turn | undefined;
  let activeSettle: ((result: TurnResult) => void) | undefined;
  const turns: Turn[] = [];
  const steered: string[] = [];

  const prompt: IAgentPromptService = {
    _serviceBrand: undefined,
    prompt: () => {
      if (options.blockPrompt === true) return Promise.resolve(undefined);
      if (activeTurn !== undefined) return Promise.resolve(undefined);
      const { turn, settle } = controlledTurn(nextTurnId++);
      activeTurn = turn;
      activeSettle = settle;
      turns.push(turn);
      void turn.result.then(() => {
        if (activeTurn === turn) {
          activeTurn = undefined;
          activeSettle = undefined;
        }
      });
      return Promise.resolve(turn);
    },
    steer: (message) => {
      for (const part of message.content) {
        if (part.type === 'text') steered.push(part.text);
      }
      return {
        removeFromQueue: () => {},
        launched: Promise.resolve(activeTurn),
      };
    },
    retry: () => undefined,
    undo: () => 0,
    clear: () => {},
    hooks: createHooks(['onWillSubmitPrompt']) as IAgentPromptService['hooks'],
  };

  const turnService: IAgentTurnService = {
    launch: () => {
      throw new Error('not used');
    },
    getActiveTurn: () => activeTurn,
    recordSteer: () => {},
    cancel: () => activeTurn !== undefined,
    hooks: {
      onLaunched: { run: async () => {} },
      onEnded: { run: async () => {} },
    },
  } as unknown as IAgentTurnService;

  const profile = {
    setModel: () => Promise.resolve({ model: '' }),
    setThinking: () => {},
  } as unknown as IAgentProfileService;

  const permissionMode = {
    setMode: () => {},
  } as unknown as IAgentPermissionModeService;

  const ensureReady = vi.fn().mockResolvedValue(undefined);
  const authSummary = {
    ensureReady,
    summarize: vi.fn().mockResolvedValue([]),
  } as unknown as IAuthSummaryService;

  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(IAgentPromptService, prompt);
      reg.defineInstance(IAgentTurnService, turnService);
      reg.defineInstance(IAgentProfileService, profile);
      reg.defineInstance(IAgentPermissionModeService, permissionMode);
      reg.defineInstance(IAuthSummaryService, authSummary);
      reg.definePartialInstance(ISessionContext, {
        sessionId: 'session_test',
      });
      reg.definePartialInstance(ISessionMetadata, {
        read: vi.fn().mockResolvedValue({
          id: 'session_test',
          createdAt: 0,
          updatedAt: 0,
          archived: false,
        }),
        update: vi.fn().mockResolvedValue(undefined),
      });
      reg.definePartialInstance(IEventService, {
        publish: vi.fn(),
      });
      reg.define(IAgentPromptLegacyService, AgentPromptLegacyService);
    },
  });
  const service = ix.get(IAgentPromptLegacyService);
  return {
    service,
    turns,
    steered,
    ensureReady,
    settleActive: (result) => activeSettle?.(result),
  };
}

describe('AgentPromptLegacyService', () => {
  it('launches a turn on submit and reports running', async () => {
    const { service, turns } = createHarness();
    const result = await service.submit(textBody('hi'));
    expect(result.status).toBe('running');
    expect(result.prompt_id).toMatch(/^msg_/);
    expect(turns).toHaveLength(1);
    expect(service.list().active?.prompt_id).toBe(result.prompt_id);
  });

  it('checks auth readiness without the request model override to match v1', async () => {
    const { service, ensureReady } = createHarness();
    await service.submit({ ...textBody('hi'), model: 'request-model' });
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(ensureReady).toHaveBeenCalledWith();
  });

  it('queues a second submit while a turn is active', async () => {
    const { service, turns } = createHarness();
    const first = await service.submit(textBody('first'));
    const second = await service.submit(textBody('second'));
    expect(second.status).toBe('queued');
    expect(turns).toHaveLength(1);
    const list = service.list();
    expect(list.active?.prompt_id).toBe(first.prompt_id);
    expect(list.queued.map((q) => q.prompt_id)).toEqual([second.prompt_id]);
  });

  it('reports blocked without queueing when no turn is launched', async () => {
    const { service, turns } = createHarness({ blockPrompt: true });
    const result = await service.submit(textBody('blocked'));
    expect(result.status).toBe('blocked');
    expect(turns).toHaveLength(0);
    expect(service.list()).toEqual({ active: null, queued: [] });
  });

  it('auto-launches the next queued prompt when the active turn settles', async () => {
    const { service, turns, settleActive } = createHarness();
    await service.submit(textBody('first'));
    const second = await service.submit(textBody('second'));
    settleActive({ type: 'completed', steps: 0, truncated: false });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(service.list().active?.prompt_id).toBe(second.prompt_id);
  });

  it('aborts the active prompt and starts the next queued on settle', async () => {
    const { service, turns, settleActive } = createHarness();
    const first = await service.submit(textBody('first'));
    const second = await service.submit(textBody('second'));
    const aborted = await service.abort(first.prompt_id);
    expect(aborted.aborted).toBe(true);
    settleActive({ type: 'cancelled', steps: 0, reason: 'Aborted' });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(service.list().active?.prompt_id).toBe(second.prompt_id);
  });

  it('removes a queued prompt on abort', async () => {
    const { service } = createHarness();
    await service.submit(textBody('first'));
    const second = await service.submit(textBody('second'));
    const aborted = await service.abort(second.prompt_id);
    expect(aborted.aborted).toBe(true);
    expect(service.list().queued).toEqual([]);
  });

  it('steers queued prompts into the active turn', async () => {
    const { service, steered } = createHarness();
    await service.submit(textBody('first'));
    const second = await service.submit(textBody('second'));
    const result = await service.steer([second.prompt_id]);
    expect(result.steered).toBe(true);
    expect(result.prompt_ids).toEqual([second.prompt_id]);
    expect(steered).toEqual(['second']);
    expect(service.list().queued).toEqual([]);
  });

  it('throws PROMPT_NOT_FOUND when aborting an unknown prompt', async () => {
    const { service } = createHarness();
    await expect(service.abort('prompt_missing')).rejects.toMatchObject({
      code: 'prompt.not_found',
    });
  });

  it('throws PROMPT_NOT_FOUND when steering with no active turn', async () => {
    const { service } = createHarness();
    await expect(service.steer(['prompt_x'])).rejects.toMatchObject({
      code: 'prompt.not_found',
    });
  });

  it('submitAndSettle resolves completion with the turn result', async () => {
    const { service, settleActive } = createHarness();
    const { submit, completion } = await service.submitAndSettle(textBody('hi'));
    expect(submit.status).toBe('running');
    settleActive({ type: 'completed', steps: 0, truncated: false });
    await expect(completion).resolves.toMatchObject({
      promptId: submit.prompt_id,
      result: { type: 'completed' },
    });
  });

  it('submitAndSettle resolves a queued prompt after it launches and settles', async () => {
    const { service, settleActive } = createHarness();
    await service.submitAndSettle(textBody('first'));
    const second = await service.submitAndSettle(textBody('second'));
    expect(second.submit.status).toBe('queued');

    // Settle the active (first) turn so the queued second prompt launches.
    settleActive({ type: 'completed', steps: 0, truncated: false });
    await vi.waitFor(() =>
      expect(service.list().active?.prompt_id).toBe(second.submit.prompt_id),
    );

    // Settle the now-active second turn; its completion should resolve.
    settleActive({ type: 'completed', steps: 0, truncated: false });
    await expect(second.completion).resolves.toMatchObject({
      promptId: second.submit.prompt_id,
      result: { type: 'completed' },
    });
  });

  it('submitAndSettle rejects completion when the prompt is blocked', async () => {
    const { service } = createHarness({ blockPrompt: true });
    const { submit, completion } = await service.submitAndSettle(textBody('blocked'));
    expect(submit.status).toBe('blocked');
    const outcome = completion.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    expect(await outcome).toBe('rejected');
  });

  it('submitAndSettle rejects completion when a queued prompt is aborted', async () => {
    const { service } = createHarness();
    await service.submitAndSettle(textBody('first'));
    const second = await service.submitAndSettle(textBody('second'));
    const outcome = second.completion.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    await service.abort(second.submit.prompt_id);
    expect(await outcome).toBe('rejected');
  });
});
