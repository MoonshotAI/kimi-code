import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '#human/llm/message';
import { IAgentLoopService } from '#/agent/loop/loop';
import { LOOP_CONTROL_SECTION } from '#/agent/loop/configSection';
import { IConfigService } from '#/app/config/config';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEventBus } from '#/app/event/eventBus';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import type { ExecutableTool } from '#/tool/toolContract';
import type { ProcessTaskInfo } from '#/agent/tools/os/bash/process-task';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  wireRecordPersistenceServices,
  type TestAgentContext,
} from '../../harness';
import { submitPromptTurn } from './stubs';

describe('core LoopService integration', () => {
  let ctx: TestAgentContext;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('runs a text-only turn through the real RPC path', async () => {
    ctx.get(IAgentProfileService).update({ activeToolNames: [] });
    ctx.mockNextResponse({ type: 'think', think: 'reasoning' }, { type: 'text', text: 'answer' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(JSON.stringify(ctx.lastLlmInput())).toContain('"Hello"');
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.step.completed',
        args: expect.objectContaining({ llmFirstTokenLatencyMs: expect.any(Number) }),
      }),
    );
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({ event: 'turn.ended', args: expect.objectContaining({ reason: 'completed' }) }),
    );
  });

  it('executes a tool batch and continues with a second core step', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };
    await ctx.get(IConfigService).set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 0 });
    ctx.get(IAgentProfileService).update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);
    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is lookup-result.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    expect(JSON.stringify(ctx.llmInputs())).toContain('lookup-result');
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({ event: 'turn.ended', args: expect.objectContaining({ reason: 'completed' }) }),
    );
  });

  it('serializes queued prompts in FIFO order with one active turn', async () => {
    const loop = ctx.get(IAgentLoopService);
    const events: string[] = [];
    const subscription = ctx.get(IEventBus).subscribe((event) => {
      if (event instanceof TurnStarted || event instanceof TurnEnded) {
        events.push(`${event.type}:${event.turnId}`);
      }
    });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    ctx.mockNextResponse({ type: 'text', text: 'three' });

    const first = submitPromptTurn(loop, { message: { role: 'user', content: [{ type: 'text', text: 'first' }] } }).turn;
    const second = submitPromptTurn(loop, { message: { role: 'user', content: [{ type: 'text', text: 'second' }] } }).turn;
    const third = submitPromptTurn(loop, { message: { role: 'user', content: [{ type: 'text', text: 'third' }] } }).turn;
    await Promise.all([first.result, second.result, third.result]);
    subscription.dispose();

    expect(events).toEqual([
      'turn.started:0',
      'turn.ended:0',
      'turn.started:1',
      'turn.ended:1',
      'turn.started:2',
      'turn.ended:2',
    ]);
    expect(ctx.llmCalls).toHaveLength(3);
  });

  it('retries a failed step through the registered loop error handler', async () => {
    const loop = ctx.get(IAgentLoopService);
    const seen: unknown[] = [];
    loop.registerLoopErrorHandler({
      id: 'test-recovery',
      match: () => true,
      handle: async (hookCtx) => {
        seen.push(hookCtx.error);
        ctx.mockNextResponse({ type: 'text', text: 'Recovered.' });
        hookCtx.retry();
        return true;
      },
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(seen).toHaveLength(1);
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({ event: 'turn.ended', args: expect.objectContaining({ reason: 'completed' }) }),
    );
  });

  it('maps the max-steps failure and bypasses the notified turn’s first step', async () => {
    const loop = ctx.get(IAgentLoopService);
    await ctx.get(IConfigService).set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 1 });
    const lookupCall = (id: string): ToolCall => ({
      type: 'function',
      id,
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    });
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };
    ctx.get(IAgentProfileService).update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);
    loop.hooks.onDidFinishStep.register('ordinary-notify', async (hookCtx, next) => {
      if (hookCtx.turnId === 0 && hookCtx.step === 1) {
        loop.notify({
          message: { role: 'user', content: [{ type: 'text', text: 'ordinary continuation' }] },
        });
      }
      await next();
    });
    loop.hooks.onDidFinishStep.register('bypass-notify', async (hookCtx, next) => {
      if (hookCtx.turnId === 1 && hookCtx.step === 1) {
        loop.notify({
          message: { role: 'user', content: [{ type: 'text', text: 'bypass continuation' }] },
          bypassMaxSteps: true,
        });
      }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'first answer' }, lookupCall('call_first'));
    ctx.mockNextResponse({ type: 'text', text: 'ordinary answer' });
    ctx.mockNextResponse({ type: 'text', text: 'bypass tool' }, lookupCall('call_bypass'));
    ctx.mockNextResponse({ type: 'text', text: 'bypass answer' });

    const { turn } = submitPromptTurn(loop, {
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    await ctx.untilApproval(true);
    await expect(turn.result).resolves.toMatchObject({
      type: 'failed',
      steps: 1,
      error: expect.objectContaining({ name: 'LoopError' }),
    });
    await ctx.untilApproval(true);
    await loop.settled();

    expect(ctx.llmCalls).toHaveLength(4);
    const bypassSteps = ctx.allEvents
      .filter((event) => event.type === '[rpc]' && event.event === 'turn.step.started')
      .map((event) => event.args as { turnId: number; step: number })
      .filter((event) => event.turnId === 2)
      .map((event) => event.step);
    expect(bypassSteps).toEqual([1, 2]);
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({ event: 'turn.ended', args: expect.objectContaining({ turnId: 2, reason: 'completed' }) }),
    );
  });

  it('settles a notification-seeded turn and its prompt waiter', async () => {
    const loop = ctx.get(IAgentLoopService);
    ctx.mockNextResponse({ type: 'text', text: 'seeded answer' });
    loop.notify({
      message: {
        role: 'user',
        id: 'seed-1',
        content: [{ type: 'text', text: 'wake up' }],
      },
    });

    let handle: ReturnType<IAgentLoopService['promptHandle']>;
    await vi.waitFor(() => {
      handle = loop.promptHandle('seed-1');
      expect(handle).toBeDefined();
    });
    await expect(handle!.completion).resolves.toMatchObject({ state: 'completed' });
    await loop.settled();
  });

  it('honors afterStep stopTurn without starting another LLM step', async () => {
    const loop = ctx.get(IAgentLoopService);
    loop.hooks.onDidFinishStep.register('test-stop', async (hookCtx, next) => {
      hookCtx.stopTurn = true;
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'This should not run.' });

    const { turn } = submitPromptTurn(loop, {
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    await expect(turn.result).resolves.toEqual({ type: 'completed', steps: 1, truncated: false });
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('distinguishes prompt blocked and gate failure while applying hookParts on success', async () => {
    const loop = ctx.get(IAgentLoopService);
    loop.hooks.onBeforeSubmitPrompt.register('test-gate', async (hookCtx, next) => {
      const text = hookCtx.promptMessage.content[0];
      const value = text?.type === 'text' ? text.text : '';
      if (value === 'block') hookCtx.block = true;
      if (value === 'fail') throw new Error('gate exploded');
      hookCtx.hookParts.push({ type: 'text', text: 'hook-prefix' });
      await next();
    });

    const blocked = loop.submit({
      message: { role: 'user', content: [{ type: 'text', text: 'block' }] },
      meta: { promptId: 'blocked', tracked: true },
    });
    await expect(loop.promptHandle(blocked.id)!.completion).resolves.toMatchObject({ state: 'blocked' });
    const failed = loop.submit({
      message: { role: 'user', content: [{ type: 'text', text: 'fail' }] },
      meta: { promptId: 'failed', tracked: true },
    });
    await expect(loop.promptHandle(failed.id)!.completion).resolves.toMatchObject({ state: 'failed' });

    ctx.mockNextResponse({ type: 'text', text: 'allowed' });
    const allowed = loop.submit({
      message: { role: 'user', content: [{ type: 'text', text: 'allowed' }] },
      meta: { promptId: 'allowed', tracked: true },
    });
    const allowedCompletion = await loop.promptHandle(allowed.id)!.completion;
    expect(allowedCompletion).toMatchObject({ state: 'completed' });
    expect(ctx.llmCalls).toHaveLength(1);
    expect(JSON.stringify(ctx.lastLlmInput())).toContain('hook-prefix');
  });

  it('rebuilds the core loop after undo with continuous turn ids', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first' }] });
    await ctx.untilTurnEnd();
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second' }] });
    await ctx.untilTurnEnd();

    await ctx.get(IAgentConversationUndoService).undo(1);
    ctx.mockNextResponse({ type: 'text', text: 'third' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'third' }] });
    await ctx.untilTurnEnd();

    const started = ctx.allEvents.filter(
      (event) => event.type === '[rpc]' && event.event === 'turn.started',
    );
    expect(started.map((event) => (event.args as { turnId: number }).turnId)).toEqual([0, 1, 2]);
    expect(ctx.context.history().some((message) => message.content.some((part) => part.type === 'text' && part.text === 'second'))).toBe(false);
  });

  it('keeps full compaction on the independent side-request path and uses the new history next step', async () => {
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);
    const compacted = new Promise<void>((resolve) => {
      ctx.emitter.once('full_compaction.complete', () => resolve());
    });
    const completed = ctx.once('compaction.completed');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({ instruction: 'Keep the important test facts.' });
    await compacted;
    await completed;

    ctx.mockNextResponse({ type: 'text', text: 'after compaction' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();

    expect(JSON.stringify(ctx.llmInputs())).toContain('Compacted summary.');
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({ event: 'turn.ended', args: expect.objectContaining({ reason: 'completed' }) }),
    );
  });

  it('steers a queued prompt into the next turn and settles both waiters', async () => {
    const loop = ctx.get(IAgentLoopService);
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      loop.hooks.onWillBeginStep.register('hold-first-step', async (hookCtx, next) => {
        if (hookCtx.turnId === 0 && hookCtx.step === 1) {
          resolve();
          await new Promise<void>((done) => {
            release = done;
          });
        }
        await next();
      });
    });
    const first = loop.submit({
      message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
      meta: { promptId: 'first', tracked: true },
    });
    await started;
    const second = loop.submit({
      message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
      meta: { promptId: 'second', tracked: true },
    });
    await loop.steer([second.id]);
    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    ctx.mockNextResponse({ type: 'text', text: 'steered answer' });
    release();

    await expect(loop.promptHandle(first.id)!.completion).resolves.toMatchObject({ state: 'completed' });
    await expect(loop.promptHandle(second.id)!.completion).resolves.toMatchObject({ state: 'completed' });
    expect(ctx.llmCalls).toHaveLength(2);
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({ event: 'prompt.steered', args: expect.objectContaining({ promptIds: ['second'] }) }),
    );
  });

  it('cancels the active turn and explicitly continues queued work', async () => {
    const loop = ctx.get(IAgentLoopService);
    const started = new Promise<void>((resolve) => {
      loop.hooks.onWillBeginStep.register('hold-active', async (hookCtx, next) => {
        if (hookCtx.turnId === 0) {
          resolve();
          await new Promise<void>((done) => {
            hookCtx.signal.addEventListener('abort', () => done(), { once: true });
          });
        }
        await next();
      });
    });
    const first = submitPromptTurn(loop, {
      message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
      meta: { promptId: 'first', tracked: true },
    }).turn;
    const second = submitPromptTurn(loop, {
      message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
      meta: { promptId: 'second', tracked: true },
    }).turn;
    await started;

    expect(loop.cancel({ turnId: 0 }, 'stop')).toBe(true);
    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await expect(first.result).resolves.toMatchObject({ type: 'cancelled' });
    await expect(second.result).resolves.toMatchObject({ type: 'completed' });
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('holds admissions during quiescence and drains them on release', async () => {
    const loop = ctx.get(IAgentLoopService);
    const lease = loop.tryAcquireQuiescence();
    expect(lease).toBeDefined();
    const held = submitPromptTurn(loop, {
      message: { role: 'user', content: [{ type: 'text', text: 'held' }] },
      meta: { promptId: 'held', tracked: true },
    }).turn;

    expect(loop.snapshot().paused).toBe(true);
    expect(ctx.llmCalls).toHaveLength(0);
    ctx.mockNextResponse({ type: 'text', text: 'released' });
    lease?.dispose();
    await expect(held.result).resolves.toMatchObject({ type: 'completed' });
    expect(loop.snapshot().paused).toBe(false);
  });

  it('restores an interrupted public Wire turn without resuming Core-only unfinished state', async () => {
    const original = createTestAgent();
    await original.restorePersisted();
    const workTool: ExecutableTool = {
      name: 'Work',
      description: 'Pretend to work.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      resolveExecution: () => ({
        approvalRule: 'Work',
        execute: () => new Promise(() => {}),
      }),
    };
    original.get(IAgentProfileService).update({ activeToolNames: ['Work'] });
    original.get(IAgentToolRegistryService).register(workTool);
    original.mockNextResponse(
      { type: 'text', text: 'working' },
      { type: 'function', id: 'call-work', name: 'Work', arguments: '{}' },
    );
    await original.rpc.prompt({ input: [{ type: 'text', text: 'interrupted' }] });
    await original.untilApproval(true);
    await vi.waitFor(() => {
      expect(original.llmCalls.length).toBeGreaterThan(0);
    });
    const records = await original.persistedWireRecords();

    const resumed = createTestAgent(wireRecordPersistenceServices(new InMemoryWireRecordPersistence(records)));
    ctx = resumed;
    await resumed.restorePersisted();

    expect(resumed.llmCalls).toHaveLength(0);
    expect(resumed.get(IAgentLoopService).history()).toContainEqual(
      expect.objectContaining({ role: 'tool', toolCallId: 'call-work', isError: true }),
    );
    resumed.mockNextResponse({ type: 'text', text: 'fresh answer' });
    await resumed.rpc.prompt({ input: [{ type: 'text', text: 'fresh prompt' }] });
    await resumed.untilTurnEnd();

    const started = resumed.allEvents.filter(
      (event) => event.type === '[rpc]' && event.event === 'turn.started',
    );
    expect(started.map((event) => (event.args as { turnId: number }).turnId)).toEqual([1]);
    expect(resumed.allEvents).toContainEqual(
      expect.objectContaining({ event: 'turn.ended', args: expect.objectContaining({ turnId: 1, reason: 'completed' }) }),
    );
    await original.dispose();
  });

  it('closes after the final LLM outcome and persists the FIFO tail', async () => {
    const subject = createTestAgent();
    await subject.restorePersisted();
    try {
      const loop = subject.get(IAgentLoopService);
      const started = createControlledPromise<void>();
      const release = createControlledPromise<void>();
      loop.hooks.onWillBeginStep.register('hold-close', async (hookCtx, next) => {
        if (hookCtx.turnId === 0) {
          started.resolve();
          await release;
        }
        await next();
      });
      const first = loop.submit({
        message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
        meta: { promptId: 'first', tracked: true },
      });
      const second = loop.submit({
        message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
        meta: { promptId: 'second', tracked: true },
      });
      const firstCompletion = loop.promptHandle(first.id)!.completion;
      const secondCompletion = loop.promptHandle(second.id)!.completion;
      await started;

      let closed = false;
      const closing = loop.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      release.resolve();
      await closing;

      await expect(firstCompletion).resolves.toMatchObject({ state: 'cancelled' });
      await expect(secondCompletion).resolves.toMatchObject({ state: 'cancelled' });
      expect(subject.llmCalls).toHaveLength(0);
      const records = await subject.persistedWireRecords();
      expect(records.some((record) =>
        record.type === 'context.append_loop_event' &&
        (record['event'] as { type?: unknown } | undefined)?.type === 'step.end'
      )).toBe(true);
      expect(records.some((record) => record.type === 'turn.ended')).toBe(true);
    } finally {
      await subject.dispose();
    }
  });

  it('reuses the same close promise and rejects new work', async () => {
    const subject = createTestAgent();
    await subject.restorePersisted();
    try {
      const loop = subject.get(IAgentLoopService);
      const first = loop.close();
      const second = loop.close();

      expect(second).toBe(first);
      await Promise.all([first, second]);
      expect(() => loop.submit({ message: { role: 'user', content: [] } })).toThrow();
    } finally {
      await subject.dispose();
    }
  });

  it('cancels parked work without starting it when quiescence is released after close', async () => {
    const subject = createTestAgent();
    await subject.restorePersisted();
    try {
      const loop = subject.get(IAgentLoopService);
      const lease = loop.tryAcquireQuiescence();
      const parked = loop.submit({
        message: { role: 'user', content: [{ type: 'text', text: 'parked' }] },
        meta: { promptId: 'parked', tracked: true },
      });
      const completion = loop.promptHandle(parked.id)!.completion;

      await loop.close();
      lease?.dispose();

      await expect(completion).resolves.toMatchObject({ state: 'cancelled' });
      expect(subject.llmCalls).toHaveLength(0);
      expect(loop.snapshot().queue).toHaveLength(0);
    } finally {
      await subject.dispose();
    }
  });

  it('publishes detached task lifecycle once with model acknowledgements and final metadata', async () => {
    const run = async (closeWhileRunning: boolean): Promise<void> => {
      const subject = createTestAgent();
      await subject.restorePersisted();
      const gate = createControlledPromise<void>();
      try {
        const loop = subject.get(IAgentLoopService);
        const detached = createControlledPromise<void>();
        let processInfo: ProcessTaskInfo & { stopCode?: string } = {
          taskId: 'task-process',
          description: 'process work',
          status: 'running',
          detached: false,
          startedAt: 100,
          endedAt: null,
          kind: 'process',
          command: 'sleep 1',
          pid: 123,
          exitCode: null,
        };
        const workTool: ExecutableTool = {
          name: 'Work',
          description: 'Complete background work.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          resolveExecution: () => ({
            approvalRule: 'Work',
            execute: async (toolCtx) => {
              processInfo = { ...processInfo, detached: true };
              loop.detachTool({
                taskId: processInfo.taskId,
                toolCallId: toolCtx.toolCallId,
                info: () => processInfo,
              }, `background task_id=${processInfo.taskId}`);
              detached.resolve();
              await gate;
              return { output: 'background-result' };
            },
          }),
        };
        subject.get(IAgentProfileService).update({ activeToolNames: ['Work'] });
        subject.get(IAgentToolRegistryService).register(workTool);
        subject.mockNextResponse(
          { type: 'text', text: 'working' },
          { type: 'function', id: 'process-call', name: 'Work', arguments: '{}' },
        );
        subject.mockNextResponse({ type: 'text', text: 'detached' });
        subject.mockNextResponse({ type: 'text', text: 'async finished' });
        const submitted = loop.submit({
          message: { role: 'user', content: [{ type: 'text', text: 'start work' }] },
          meta: { promptId: 'work', tracked: true },
        });
        await subject.untilApproval(true);
        await detached;
        if (closeWhileRunning) {
          await loop.close();
        } else {
          processInfo = {
            ...processInfo,
            status: 'timed_out',
            endedAt: 500,
            exitCode: 124,
            stopReason: 'deadline',
            stopCode: 'TASK_TIMEOUT',
          };
          gate.resolve();
          await expect(loop.promptHandle(submitted.id)!.completion).resolves.toMatchObject({ state: 'completed' });
          await loop.settled();
          await loop.close();
        }
        await vi.waitFor(() => {
          expect(subject.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'task.terminated')).toHaveLength(1);
        });

        const records = await subject.persistedWireRecords();
        const started = records.filter((record) => record.type === 'task.started').map((record) => record['info']);
        const terminated = records.filter((record) => record.type === 'task.terminated').map((record) => record['info']);
        expect(started).toEqual([
          expect.objectContaining({ taskId: 'task-process', status: 'running', detached: true, startedAt: 100, endedAt: null, exitCode: null }),
        ]);
        if (closeWhileRunning) {
          expect(terminated).toEqual([
            expect.objectContaining({ taskId: 'task-process', status: 'killed', startedAt: 100, endedAt: expect.any(Number) }),
          ]);
        } else {
          expect(terminated).toEqual([
            expect.objectContaining({ taskId: 'task-process', status: 'timed_out', startedAt: 100, endedAt: 500, exitCode: 124, stopReason: 'deadline', stopCode: 'TASK_TIMEOUT' }),
          ]);
        }
        expect(subject.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'task.started')).toHaveLength(1);
        expect(records.every((record) => !record.type.startsWith('agent.'))).toBe(true);
        if (!closeWhileRunning) {
          expect(JSON.stringify(subject.llmInputs())).toContain('task_id=task-process');
          expect(JSON.stringify(records)).toContain('background-result');
          expect(JSON.stringify(records)).toContain('async finished');
        }
      } finally {
        gate.resolve();
        (subject as unknown as { root: { dispose(): void } }).root.dispose();
      }
    };

    await run(false);
    await run(true);
  });

  it('waits for loop close before disposing an adopted agent scope', async () => {
    const subject = createTestAgent();
    await subject.restorePersisted();
    const loop = subject.get(IAgentLoopService);
    const handle = subject.get(IAgentLifecycleService).handleOf('main');
    if (handle === undefined) throw new Error('missing adopted agent handle');
    const closeStarted = createControlledPromise<void>();
    const releaseClose = createControlledPromise<void>();
    const close = loop.close.bind(loop);
    loop.close = () => {
      closeStarted.resolve();
      return close().then(() => releaseClose);
    };

    const disposing = Promise.resolve(handle.dispose());
    await closeStarted;
    expect(handle.accessor.get(IAgentScopeContext).agentId).toBe('main');
    releaseClose.resolve();
    await disposing;

    expect(() => handle.accessor.get(IAgentScopeContext)).toThrow();
    (subject as unknown as { root: { dispose(): void } }).root.dispose();
  });
});
