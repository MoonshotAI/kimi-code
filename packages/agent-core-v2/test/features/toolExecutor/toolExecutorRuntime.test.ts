import { afterEach, describe, expect, it } from 'vitest';

import type { ToolCall } from '#/kosong/contract/message';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ToolExecution,
} from '#/tool/toolContract';
import {
  AgentToolExecutor,
  type ToolExecutorRuntime,
} from '#/features/toolExecutor/toolExecutorAgentRuntime';
import type { ToolExecutionFinishedEvent } from '#/features/toolExecutor/toolExecutor';
import { denyToolExecution } from '#/features/toolExecutor/toolHooks';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';

import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';

import { createTestAgent, type TestAgentContext } from '../../harness';

class EchoTool implements ExecutableTool<Record<string, unknown>> {
  readonly name = 'Echo';
  readonly description = 'Echo input text.';
  readonly parameters = { type: 'object', additionalProperties: true };

  resolveExecution(args: Record<string, unknown>): ToolExecution {
    return {
      approvalRule: 'Echo',
      execute: async (ctx: ExecutableToolContext) => ({
        output: typeof args['text'] === 'string' ? args['text'] : '',
      }),
    };
  }
}

function echoCall(id: string, text: string): ToolCall {
  return { type: 'function', id, name: 'Echo', arguments: JSON.stringify({ text }) };
}

describe('ToolExecutorRuntime (AgentToolExecutor)', () => {
  let ctx: TestAgentContext;
  let executor: ToolExecutorRuntime;

  afterEach(async () => {
    await ctx?.dispose();
  });

  async function setup(): Promise<void> {
    ctx = createTestAgent();
    await ctx.rpc.setPermission({ mode: 'yolo' });
    executor = ctx.resolve(AgentToolExecutor);
    ctx.get(IAgentToolRegistryService).register(new EchoTool());
  }

  it('resolves through the lifecycle and executes a registered tool end-to-end', async () => {
    await setup();
    const finished: ToolExecutionFinishedEvent[] = [];
    executor.onDidExecute((event) => finished.push(event));

    const results = [];
    for await (const item of executor.execute([echoCall('call_1', 'hello')], {
      turnId: 0,
      signal: new AbortController().signal,
    })) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0]!.toolCallId).toBe('call_1');
    expect(results[0]!.result.output).toBe('hello');
    expect(results[0]!.result.isError).not.toBe(true);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      turnId: 0,
      toolName: 'Echo',
      result: { output: 'hello' },
    });
  });

  it('settles a prePolicy veto before the tool executes and reports it through onDidExecute', async () => {
    await setup();
    const finished: ToolExecutionFinishedEvent[] = [];
    executor.participateExecution('test-deny', (event) => {
      event.veto(denyToolExecution('denied by test'));
    });
    executor.onDidExecute((event) => finished.push(event));

    const results = [];
    for await (const item of executor.execute([echoCall('call_2', 'hello')], {
      turnId: 0,
      signal: new AbortController().signal,
    })) {
      results.push(item);
    }

    expect(results[0]!.result.output).toBe('denied by test');
    expect(results[0]!.result.isError).toBe(true);
    expect(finished[0]!.result.isError).toBe(true);
  });

  it('runs prePolicy did-hooks before postPolicy did-hooks', async () => {
    await setup();
    const order: string[] = [];
    executor.registerDidExecuteHook('test-late', async (_ctx, next) => {
      order.push('post');
      await next();
    }, 'postPolicy');
    executor.registerDidExecuteHook('test-early', async (_ctx, next) => {
      order.push('pre');
      await next();
    });

    for await (const _item of executor.execute([echoCall('call_3', 'hi')], {
      turnId: 0,
      signal: new AbortController().signal,
    })) {
    }

    expect(order).toEqual(['pre', 'post']);
  });

  it('orders veto participants and did-hooks exactly as the pre-migration wiring did', async () => {
    await setup();
    const lifecycle = ctx.get(IAgentLifecycleService) as AgentLifecycleService;
    await lifecycle.restoreRuntimes(ctx.agentContext);
    const snapshot = ctx
      .get(IAgentLifecycleService)
      .inspect(ctx.agentContext);
    const contribution = snapshot.contributions.find((entry) => entry.id === 'toolExecutor');
    expect(contribution?.state).toEqual({
      veto: [
        'externalHooks',
        'plan',
        'swarm',
        'staleGuard',
        'tower-tool-guard',
        'tower-todolist-guard',
        'tower-worktree-guard',
        'toolDedupe',
        'permissionGate',
        'goal-approval',
        'goal-veto',
      ],
      did: [
        'externalHooks',
        'prompt-service-delivery',
        'staleGuard',
        'toolDedupe',
        'agentsMdReminder',
        'goal-outcome-tool-result',
      ],
    });
  });

  it('keeps the internal dedupe policy between participants and policies', async () => {
    await setup();
    const calls: string[] = [];
    executor.participateExecution('test-observer', () => {
      calls.push('observer');
    });

    const results = [];
    for await (const item of executor.execute(
      [echoCall('call_4a', 'same'), echoCall('call_4b', 'same')],
      { turnId: 0, signal: new AbortController().signal },
    )) {
      results.push(item);
    }

    expect(calls).toEqual(['observer', 'observer']);
    expect(results[1]!.result.output).toBe('same');
  });
});
