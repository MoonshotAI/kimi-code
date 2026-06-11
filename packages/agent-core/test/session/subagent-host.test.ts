import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { testKaos } from '../fixtures/test-kaos';
import { APIStatusError, type Message, type ToolCall } from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent, AgentOptions } from '../../src/agent';
import { AGENT_WIRE_PROTOCOL_VERSION } from '../../src/agent/records';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { collectGitContext } from '../../src/session/git-context';
import {
  SessionSubagentHost,
  type QueuedSubagentTask,
} from '../../src/session/subagent-host';
import { abortError, userCancellationReason } from '../../src/utils/abort';
import { testAgent, type AgentTestContext } from '../agent/harness/agent';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { executeTool } from '../tools/fixtures/execute-tool';

// Git context collection is exercised in git-context.test.ts; here it is
// mocked so subagent-host tests stay deterministic and assert only the
// wiring (explore subagents get the block prepended, others do not).
vi.mock('../../src/session/git-context', () => ({
  collectGitContext: vi.fn(async () => ''),
}));

const signal = new AbortController().signal;
const tempDirs: string[] = [];
type GenerateFn = NonNullable<AgentOptions['generate']>;

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('SessionSubagentHost', () => {
  it('emits a suspended event for a requeued child', () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();
    const child = testAgent();
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    host.suspended({
      task: queuedTask(1),
      agentId: 'agent-0',
      reason: 'Provider rate limit; subagent requeued for retry.',
    });

    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.suspended',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          reason: 'Provider rate limit; subagent requeued for retry.',
        }),
      }),
    );
  });

  it('runQueued suppresses raw live Aborted failures from queued attempts', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const running = host.runQueued([{ ...queuedTask(1), signal: controller.signal }]);
    void running.catch(() => {});

    await child.untilApprovalRequest();
    controller.abort(abortError());
    await expect(running).rejects.toThrow('Aborted');
    await child.untilTurnEnd();

    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
        args: expect.objectContaining({
          error: 'Aborted',
        }),
      }),
    );
  });

  it('fires subagent lifecycle hooks around the child turn', async () => {
    const child = testAgent();
    const calls: Array<{ readonly event: string; readonly childLlmCallCount: number }> = [];
    const trigger = vi.fn(async (event: string, _args?: unknown) => {
      calls.push({ event, childLlmCallCount: child.llmCalls.length });
      return [];
    });
    const fireAndForgetTrigger = vi.fn((event: string) => {
      calls.push({ event, childLlmCallCount: child.llmCalls.length });
      return Promise.resolve([]);
    });
    const parent = testAgent({
      hookEngine: { trigger, fireAndForgetTrigger } as unknown as NonNullable<Agent['hooks']>,
    });
    parent.configure();
    parent.newEvents();

    const summary =
      'Implemented the subagent task completely and returned a detailed enough summary for the parent agent to continue confidently without repeating the child agent work. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    const startArgs = trigger.mock.calls[0]?.[1];
    expect(trigger.mock.calls[0]?.[0]).toBe('SubagentStart');
    expect(startArgs).toMatchObject({
      matcherValue: 'coder',
      inputData: {
        agentName: 'coder',
        prompt: 'Implement the fix',
      },
    });
    expect((startArgs as { readonly signal?: unknown } | undefined)?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(fireAndForgetTrigger).toHaveBeenCalledWith('SubagentStop', {
      matcherValue: 'coder',
      inputData: {
        agentName: 'coder',
        response: summary.trim(),
      },
    });
    expect(calls).toEqual([
      { event: 'SubagentStart', childLlmCallCount: 0 },
      { event: 'SubagentStop', childLlmCallCount: 1 },
    ]);
  });

  it('ignores blocking results from subagent lifecycle hooks', async () => {
    const trigger = vi.fn(async () => [{ action: 'block', reason: 'observer only' }]);
    const fireAndForgetTrigger = vi.fn(() => Promise.resolve([{ action: 'block' }]));
    const parent = testAgent({
      hookEngine: { trigger, fireAndForgetTrigger } as unknown as NonNullable<Agent['hooks']>,
    });
    parent.configure();
    parent.newEvents();

    const summary =
      'Completed the subagent task with enough implementation detail and verification context for the parent agent to continue without repeating the work. '.repeat(
        2,
      );
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result: summary.trim() });
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.completed',
        args: expect.objectContaining({ subagentId: 'agent-0' }),
      }),
    );
    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
      }),
    );
  });

  it('marks a queued child ready when the model emits thinking output', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    const summary =
      'Completed the delegated subagent task with enough concrete detail for the parent agent to continue without repeating the work. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'think', think: 'I can start.' }, { type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');
    const onReady = vi.fn();

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
      onReady,
    });

    await vi.waitFor(() => {
      expect(onReady).toHaveBeenCalledTimes(1);
    });
    await expect(handle.completion).resolves.toMatchObject({ result: summary.trim() });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('runs a child agent turn and returns the last assistant text', async () => {
    const telemetryTrack = vi.fn();
    const parent = testAgent({ telemetry: { track: telemetryTrack } });
    parent.configure();
    await parent.rpc.setPermission({ mode: 'yolo' });
    parent.agent.permission.rules.splice(0, parent.agent.permission.rules.length, {
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Read',
    });
    parent.newEvents();

    const child = testAgent({
      type: 'sub',
      permission: { parent: parent.agent.permission },
    });
    child.mockNextResponse({ type: 'text', text: 'Investigated the request and completed the child task end to end. The relevant module was located, its behavior traced through every call site, and the requested change applied and verified against the existing test suite.' });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Find the cause',
      description: 'Find cause',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({
      result: 'Investigated the request and completed the child task end to end. The relevant module was located, its behavior traced through every call site, and the requested change applied and verified against the existing test suite.',
    });
    expect(handle.agentId).toBe('agent-0');
    expect(handle.profileName).toBe('explore');

    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.spawned',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          subagentName: 'explore',
          parentAgentId: 'main',
          parentToolCallId: 'call_agent',
        }),
      }),
    );
    expect(telemetryTrack).toHaveBeenCalledWith('subagent_created', {
      subagent_name: 'explore',
      run_in_background: false,
    });
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.completed',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          resultSummary: 'Investigated the request and completed the child task end to end. The relevant module was located, its behavior traced through every call site, and the requested change applied and verified against the existing test suite.',
        }),
      }),
    );
    expect(child.agent.config.data()).toMatchObject({
      cwd: parent.agent.config.cwd,
      provider: parent.agent.config.data().provider,
      profileName: 'explore',
      thinkingLevel: parent.agent.config.thinkingLevel,
    });
    expect(child.agent.config.systemPrompt).toContain('codebase exploration specialist');
    expect(child.agent.permission.mode).toBe('yolo');
    expect(child.agent.permission.rules).toEqual([]);
    expect(child.agent.permission.data().rules).toEqual(parent.agent.permission.rules);
    expect(child.llmCalls[0]?.systemPrompt).toContain('codebase exploration specialist');
    expect(child.llmCalls[0]?.tools.map((tool) => tool.name).toSorted()).toEqual([
      'Bash',
      'Glob',
      'Grep',
      'Read',
    ]);
    expect(child.llmCalls[0]?.history).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Find the cause' }],
      },
    ]);
  });

  it('inherits active parent user tools when spawning a subagent', async () => {
    const parent = testAgent();
    parent.configure();
    await parent.rpc.registerTool(lookupToolRegistration());
    parent.newEvents();

    const summary =
      'Investigated the delegated task thoroughly, used the inherited custom lookup surface where appropriate, and returned a detailed summary that lets the parent agent continue without repeating the work. '.repeat(
        2,
      );
    const child = testAgent();
    child.mockNextResponse({
      type: 'text',
      text: summary,
    });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Use the available lookup tool',
      description: 'Use lookup',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({
      result: summary.trim(),
    });
    expect(child.llmCalls[0]?.tools.map((tool) => tool.name)).toContain('Lookup');
    expect(child.agent.tools.data()).toContainEqual({
      name: 'Lookup',
      description: 'Look up a short test value.',
      active: true,
      source: 'user',
    });

    const lookupTool = child.agent.tools.loopTools.find((tool) => tool.name === 'Lookup');
    expect(lookupTool).toBeDefined();

    const execution = executeTool(lookupTool!, {
      turnId: '0',
      toolCallId: 'call_lookup',
      args: { query: 'moon' },
      signal,
    });
    const routedTo = await Promise.race([
      child.untilToolCall({ output: 'moon-result' }).then(() => 'child'),
      parent.untilToolCall({ output: 'moon-result' }).then(() => 'parent'),
      new Promise<'timeout'>((resolve) => setTimeout(() => {
        resolve('timeout');
      }, 50)),
    ]);

    expect(routedTo).toBe('child');
    await expect(execution).resolves.toMatchObject({ output: 'moon-result' });
  });

  it('falls back to bundled subagent profiles when the parent profile is missing', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'Implemented the requested fix in the target module, updated all affected call sites, and confirmed the change compiles cleanly and passes the existing test suite. No unrelated code paths were touched while making this change.' });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({
      result:
        'Implemented the requested fix in the target module, updated all affected call sites, and confirmed the change compiles cleanly and passes the existing test suite. No unrelated code paths were touched while making this change.',
    });
    expect(child.agent.config.profileName).toBe('coder');
    expect(child.llmCalls[0]?.systemPrompt).toContain('You are now running as a subagent.');
    expect(child.llmCalls[0]?.tools.map((tool) => tool.name).toSorted()).toEqual([
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'Write',
    ]);
    expect(child.llmCalls[0]?.history).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Implement the fix' }],
      },
    ]);
  });

  it('rejects unknown subagent types before creating a child agent', async () => {
    const parent = testAgent();
    parent.configure();
    const createAgent = vi.fn();
    const host = new SessionSubagentHost(
      {
        agents: new Map([['main', parent.agent]]),
        ensureAgentResumed: vi.fn(async () => parent.agent),
        createAgent,
      } as never,
      'main',
    );

    await expect(
      host.spawn({
        profileName: 'missing',
        parentToolCallId: 'call_agent',
        prompt: 'Find the cause',
        description: 'Find cause',
        runInBackground: false,
        signal,
      }),
    ).rejects.toThrow('Subagent profile "missing" was not found');
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('rejects unavailable subagent profiles even when a same-named fork label exists', async () => {
    const parent = testAgent();
    parent.configure();
    const createAgent = vi.fn();
    const host = new SessionSubagentHost(
      {
        agents: new Map([['main', parent.agent]]),
        ensureAgentResumed: vi.fn(async () => parent.agent),
        createAgent,
      } as never,
      'main',
    );

    await expect(
      host.spawn({
        profileName: 'btw',
        parentToolCallId: 'call_agent',
        prompt: 'Answer a side question',
        description: 'Side question',
        runInBackground: false,
        signal,
      }),
    ).rejects.toThrow('Subagent profile "btw" was not found');
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('cancels the child turn when the caller signal aborts', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });

    await child.untilApprovalRequest();
    controller.abort();

    await expect(handle.completion).rejects.toThrow('Aborted');
    expect(child.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          error: 'Aborted',
        }),
      }),
    );
  });

  it('cancelAll aborts foreground children', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal,
    });

    await child.untilApprovalRequest();
    host.cancelAll();

    await expect(handle.completion).rejects.toThrow('Aborted');
    expect(child.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );
  });

  it("tells a cancelled subagent's in-flight tools the user interrupted them", async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });

    await child.untilApprovalRequest();
    // The parent turn signal aborts with a user-cancellation reason; linkAbortSignal
    // forwards it to the child exactly as Turn.cancel does on a real ESC.
    controller.abort(userCancellationReason());
    await expect(handle.completion).rejects.toThrow();
    await child.untilTurnEnd();

    const output = childBashToolResultOutput(child);
    expect(output).toContain('manually interrupted');
    expect(output).toContain('not a system error');
  });

  it('does not mislabel a non-user subagent abort (e.g. a deadline) as a user interruption', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const controller = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });

    await child.untilApprovalRequest();
    // A generic (non-user) abort — e.g. a foreground subagent's deadline timeout
    // propagating through waitForCurrentTurn — must NOT be reported to the
    // child's tools as a deliberate user interruption.
    controller.abort(abortError());
    await expect(handle.completion).rejects.toThrow();
    await child.untilTurnEnd();

    const output = childBashToolResultOutput(child);
    expect(output).toBe('Tool "Bash" was aborted');
    expect(output).not.toContain('manually interrupted');
  });

  it('cancelAll leaves background children running until their task signal aborts', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const backgroundController = new AbortController();
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Keep working',
      description: 'Long task',
      runInBackground: true,
      signal: backgroundController.signal,
    });

    await child.untilApprovalRequest();
    host.cancelAll();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(child.agent.turn.hasActiveTurn).toBe(true);
    expect(child.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );

    backgroundController.abort();

    await expect(handle.completion).rejects.toThrow('Aborted');
    expect(child.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'turn.cancel',
        args: expect.objectContaining({ turnId: 0 }),
      }),
    );
  });

  it('re-prompts the child when the first summary is too short', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const longSummary = 'Detailed findings: '.repeat(20);
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: 'done' });
    child.mockNextResponse({ type: 'text', text: longSummary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Investigate',
      description: 'Investigate',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result: longSummary.trim() });
    expect(child.llmCalls).toHaveLength(2);
    expect(child.llmCalls[1]?.history.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: expect.stringContaining('too brief') }],
    });
  });

  it('fails the child instead of re-prompting when the response is truncated', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent();
    child.mockNextProviderResponse({
      parts: [
        { type: 'think', think: 'The child used its output budget before writing a summary.' },
      ],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Investigate',
      description: 'Investigate',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).rejects.toThrow(
      'Subagent turn failed before completing its final summary: reason=max_tokens',
    );
    expect(child.llmCalls).toHaveLength(1);
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.failed',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          error: expect.stringContaining(
            'Subagent turn failed before completing its final summary: reason=max_tokens',
          ),
        }),
      }),
    );
    expect(parent.allEvents).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.completed',
      }),
    );
  });

  it('does not re-prompt when the first summary is long enough', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const longSummary = 'Comprehensive technical summary. '.repeat(10);
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: longSummary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Investigate',
      description: 'Investigate',
      runInBackground: false,
      signal,
    });

    await expect(handle.completion).resolves.toMatchObject({ result: longSummary.trim() });
    expect(child.llmCalls).toHaveLength(1);
  });

  it('prepends git context to the prompt for explore subagents', async () => {
    vi.mocked(collectGitContext).mockResolvedValueOnce(
      '<git-context>\nWorking directory: /repo\nBranch: main\n</git-context>',
    );
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const summary =
      'Explored the repository thoroughly and reported the findings in a complete and detailed summary that gives the parent agent everything it needs to continue the work without redoing the investigation all over again.';
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Find the cause',
      description: 'Find cause',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(child.llmCalls[0]?.history[0]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<git-context>\nWorking directory: /repo\nBranch: main\n</git-context>\n\nFind the cause',
        },
      ],
    });
  });

  it('does not prepend git context for non-explore subagents', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const summary =
      'Implemented the requested change in full and verified it against the existing test suite, leaving a thorough and complete summary so the parent agent can proceed without repeating any of the finished investigation work.';
    const child = testAgent();
    child.mockNextResponse({ type: 'text', text: summary });
    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the fix',
      description: 'Fix bug',
      runInBackground: false,
      signal,
    });
    await handle.completion;

    expect(child.llmCalls[0]?.history[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'Implement the fix' }],
    });
  });

  it('resumes an idle child agent by id', async () => {
    const parent = testAgent();
    parent.configure();
    parent.agent.permission.setMode('yolo');

    const child = testAgent({
      type: 'sub',
      permission: { parent: parent.agent.permission },
    });
    child.configure({ tools: ['Read'] });
    child.agent.useProfile(
      profile({ name: 'explore', tools: ['Read'], systemPrompt: 'explore prompt' }),
    );
    child.agent.context.appendUserMessage([{ type: 'text', text: 'Earlier context' }]);
    child.mockNextResponse({
      type: 'text',
      text: 'Resumed the subagent from its earlier context and carried the task through to completion, then reported a full and detailed technical summary so the parent agent can continue without repeating prior work.',
    });
    vi.mocked(collectGitContext).mockReset().mockResolvedValue('');

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': {
        homedir: '/tmp/kimi-session/agents/agent-0',
        type: 'sub',
        parentAgentId: 'main',
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.resume('agent-0', {
      parentToolCallId: 'call_agent',
      prompt: 'Continue from context',
      description: 'Continue work',
      runInBackground: false,
      signal,
    });

    expect(handle).toMatchObject({
      agentId: 'agent-0',
      profileName: 'explore',
      resumed: true,
    });
    await expect(handle.completion).resolves.toMatchObject({
      result:
        'Resumed the subagent from its earlier context and carried the task through to completion, then reported a full and detailed technical summary so the parent agent can continue without repeating prior work.',
    });
    expect(session.createAgent).not.toHaveBeenCalled();
    expect(child.agent.permission.mode).toBe('yolo');
    expect(child.lastLlmInput()).toMatchInlineSnapshot(`
      system: "explore prompt"
      tools: Read
      messages:
        user: text "Earlier context"
        user: text "Continue from context"
    `);
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.spawned',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          subagentName: 'explore',
          parentToolCallId: 'call_agent',
        }),
      }),
    );
  });

  it('runQueued resumes tasks that carry an existing agent id', async () => {
    const parent = testAgent();
    parent.configure();

    const child = testAgent({ type: 'sub' });
    child.configure();
    child.agent.useProfile(
      profile({ name: 'coder', tools: [], systemPrompt: 'coder prompt' }),
    );
    child.agent.context.appendUserMessage([{ type: 'text', text: 'Earlier swarm context' }]);
    const summary =
      'Resumed the queued swarm subagent from its prior context, completed the missing work, and returned a detailed enough handoff for the parent to proceed without starting over. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'text', text: summary });

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': {
        homedir: '/tmp/kimi-session/agents/agent-0',
        type: 'sub',
        parentAgentId: 'main',
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    await expect(
      host.runQueued(
        [
          {
            ...queuedTask(1),
            kind: 'resume',
            prompt: 'Continue the previous swarm task',
            resumeAgentId: 'agent-0',
            signal,
          },
        ],
      ),
    ).resolves.toMatchObject([
      {
        agentId: 'agent-0',
        status: 'completed',
        result: summary.trim(),
      },
    ]);

    expect(session.createAgent).not.toHaveBeenCalled();
    expect(userTextMessages(child.llmCalls[0]?.history ?? [])).toEqual([
      'Earlier swarm context',
      'Continue the previous swarm task',
    ]);
  });

  it('runQueued persists swarm item metadata for spawned tasks', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const child = testAgent({ type: 'sub' });
    child.configure();
    const summary =
      'Completed the queued swarm item and returned a detailed technical handoff so the parent can map the result back to the original swarm input. '.repeat(
        2,
      );
    child.mockNextResponse({ type: 'text', text: summary });

    const metadataAgents: Session['metadata']['agents'] = {};
    const session = fakeSession(parent.agent, child.agent, metadataAgents);
    const host = new SessionSubagentHost(session, 'main');

    await expect(
      host.runQueued([{ ...queuedTask(1), swarmItem: 'src/a.ts', signal }]),
    ).resolves.toMatchObject([
      {
        agentId: 'agent-0',
        status: 'completed',
        result: summary.trim(),
      },
    ]);

    expect(session.createAgent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        parentAgentId: 'main',
        swarmItem: 'src/a.ts',
      }),
    );
    expect(metadataAgents['agent-0']).toMatchObject({
      type: 'sub',
      parentAgentId: 'main',
      swarmItem: 'src/a.ts',
    });
    expect(host.getSwarmItem('agent-0')).toBe('src/a.ts');
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.spawned',
        args: expect.objectContaining({
          subagentId: 'agent-0',
          parentToolCallId: 'call_swarm',
          swarmIndex: 1,
        }),
      }),
    );
    expect(parent.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'subagent.started',
        args: expect.objectContaining({
          subagentId: 'agent-0',
        }),
      }),
    );
  });

  it('retries a rate-limited child turn without appending the original prompt again', async () => {
    const parent = testAgent();
    parent.configure();
    parent.newEvents();

    const summary =
      'Recovered from a provider rate limit by retrying the latest subagent step with the original context intact, then completed the delegated work with a detailed enough summary for the parent to continue confidently. '.repeat(
        2,
      );
    const histories: Message[][] = [];
    let generateCalls = 0;
    const generate: GenerateFn = async (
      _provider,
      _systemPrompt,
      _tools,
      history,
      callbacks,
    ) => {
      histories.push(structuredClone(history));
      generateCalls += 1;
      if (generateCalls === 1) {
        throw new APIStatusError(429, 'Rate limited', 'req-429');
      }
      await callbacks?.onMessagePart?.({ type: 'text', text: summary });
      return textResult(summary);
    };
    const child = testAgent({
      generate,
      initialConfig: {
        providers: {},
        loopControl: { maxRetriesPerStep: 1 },
      },
    });
    child.configure();

    const session = fakeSession(parent.agent, child.agent);
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement the retry-safe change',
      description: 'Fix rate-limit retry',
      runInBackground: false,
      signal,
    });
    await expect(handle.completion).rejects.toThrow('Rate limited');

    const retryHandle = await host.retry(handle.agentId, {
      parentToolCallId: 'call_agent',
      prompt: 'Implement the retry-safe change',
      description: 'Fix rate-limit retry',
      runInBackground: false,
      signal,
    });

    await expect(retryHandle.completion).resolves.toMatchObject({ result: summary.trim() });
    expect(generateCalls).toBe(2);
    expect(userTextMessages(histories[1] ?? [])).toEqual(['Implement the retry-safe change']);
  });

  it('realigns a resumed subagent to the parent agent current model', async () => {
    const parent = testAgent();
    parent.configure();
    parent.agent.permission.setMode('yolo');

    const child = testAgent();
    child.configure({ tools: ['Read'] });
    // The child was originally spawned with a model that no longer matches the
    // parent agent's current model (as if the parent ran setModel afterwards).
    child.agent.config.update({ modelAlias: 'stale-model-from-initial-spawn' });
    child.agent.useProfile(
      profile({ name: 'explore', tools: ['Read'], systemPrompt: 'explore prompt' }),
    );
    child.agent.context.appendUserMessage([{ type: 'text', text: 'Earlier context' }]);
    child.mockNextResponse({
      type: 'text',
      text: 'Resumed the subagent from its earlier context and carried the task through to completion, then reported a full and detailed technical summary so the parent agent can continue without repeating prior work.',
    });

    const session = fakeSession(parent.agent, child.agent, {
      'agent-0': {
        homedir: '/tmp/kimi-session/agents/agent-0',
        type: 'sub',
        parentAgentId: 'main',
      },
    });
    const host = new SessionSubagentHost(session, 'main');

    const handle = await host.resume('agent-0', {
      parentToolCallId: 'call_agent',
      prompt: 'Continue from context',
      description: 'Continue work',
      runInBackground: false,
      signal,
    });

    await handle.completion;
    // resume must realign the child to the parent agent's current model rather
    // than leave it on the stale model from its initial spawn.
    expect(child.agent.config.modelAlias).toBe(parent.agent.config.modelAlias);
    expect(child.agent.config.modelAlias).not.toBe('stale-model-from-initial-spawn');
  });
});

describe('Session resume permission parent chain', () => {
  it('restores subagent live-derived permission when metadata lists the child first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-permission-chain-'));
    tempDirs.push(dir);
    const sessionDir = join(dir, 'session');
    const workDir = join(dir, 'work');
    const mainDir = join(sessionDir, 'agents', 'main');
    const childDir = join(sessionDir, 'agents', 'agent-0');
    const sessionApprovalRule = 'Bash(printf parent)';
    await mkdir(workDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify(
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          title: 'Permission Chain',
          isCustomTitle: false,
          agents: {
            'agent-0': {
              homedir: childDir,
              type: 'sub',
              parentAgentId: 'main',
            },
            main: {
              homedir: mainDir,
              type: 'main',
              parentAgentId: null,
            },
          },
          custom: {},
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeWire(mainDir, [
      {
        type: 'permission.set_mode',
        mode: 'yolo',
      },
      {
        type: 'permission.record_approval_result',
        turnId: 0,
        toolCallId: 'call_parent_bash',
        toolName: 'Bash',
        action: 'run command',
        sessionApprovalRule,
        result: {
          decision: 'approved',
          scope: 'session',
          selectedLabel: 'Approve for this session',
        },
      },
    ]);
    await writeWire(childDir, []);

    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      homedir: sessionDir,
      rpc: createSessionRpc(),
      initializeMainAgent: false,
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });

    try {
      await session.resume();

      const child = await session.ensureAgentResumed('agent-0');
      expect(child?.permission.mode).toBe('yolo');
      expect(child?.permission.rules).toEqual([]);
      expect(child?.permission.data().rules).toEqual([]);
      expect(child?.permission.sessionApprovalRulePatterns).toContain(sessionApprovalRule);
    } finally {
      await session.close();
    }
  });
});

describe('Session.createAgent', () => {
  it('uses the Kaos current directory when the session cwd is omitted', async () => {
    const workDir = '/remote/project';
    const kaos = createFakeKaos({
      getcwd: () => workDir,
      mkdir: vi.fn(async () => {}),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if ([workDir, `${workDir}/.git`].includes(path)) {
          return stat('dir');
        }
        if ([`${workDir}/README.md`, `${workDir}/AGENTS.md`].includes(path)) {
          return stat('file');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      iterdir: async function* (path: string) {
        if (path === workDir) {
          yield `${workDir}/README.md`;
          return;
        }
        throw new Error(`ENOENT ${path}`);
      },
      readText: vi.fn(async (path: string) => {
        if (path === `${workDir}/AGENTS.md`) return 'remote instructions';
        throw new Error(`ENOENT ${path}`);
      }),
    });
    const session = new Session({
      id: 'test-subagent-remote-context',
      kaos,
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const created = await session.createAgent({ type: 'main' }, { profile: contextProfile() });

    expect(created.agent.config.systemPrompt).toContain('cwd=/remote/project');
    expect(created.agent.config.systemPrompt).toContain('listing=└── README.md');
    expect(created.agent.config.systemPrompt).toContain('remote instructions');
  });

  it('renders profiles with the current directory listing and merged AGENTS.md files', async () => {
    const workDir = '/repo/packages/app';
    const kaos = createFakeKaos({
      mkdir: vi.fn(async () => {}),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if (
          [
            '/repo',
            '/repo/.git',
            '/repo/packages',
            workDir,
            `${workDir}/src`,
            `${workDir}/.kimi-code`,
          ].includes(path)
        ) {
          return stat('dir');
        }
        if (
          [
            '/repo/AGENTS.md',
            `${workDir}/.kimi-code/AGENTS.md`,
            `${workDir}/AGENTS.md`,
            `${workDir}/package.json`,
            `${workDir}/src/index.ts`,
          ].includes(path)
        ) {
          return stat('file');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      iterdir: async function* (path: string) {
        if (path === workDir) {
          yield `${workDir}/src`;
          yield `${workDir}/package.json`;
          return;
        }
        if (path === `${workDir}/src`) {
          yield `${workDir}/src/index.ts`;
          return;
        }
        throw new Error(`ENOENT ${path}`);
      },
      readText: vi.fn(async (path: string) => {
        if (path === '/repo/AGENTS.md') return 'root instructions';
        if (path === `${workDir}/.kimi-code/AGENTS.md`) return 'brand instructions';
        if (path === `${workDir}/AGENTS.md`) return 'leaf instructions';
        throw new Error(`ENOENT ${path}`);
      }),
    });
    const session = new Session({
      id: 'test-subagent-agents-md',
      kaos: kaos.withCwd(workDir),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const created = await session.createAgent({ type: 'main' }, { profile: contextProfile() });

    expect(created.agent.config.systemPrompt).toContain('cwd=/repo/packages/app');
    expect(created.agent.config.systemPrompt).toContain('listing=├── src/');
    expect(created.agent.config.systemPrompt).toContain('│   └── index.ts');
    expect(created.agent.config.systemPrompt).toContain('└── package.json');
    expect(created.agent.config.systemPrompt).toContain('<!-- From: /repo/AGENTS.md -->');
    expect(created.agent.config.systemPrompt).toContain('root instructions');
    expect(created.agent.config.systemPrompt).toContain(
      '<!-- From: /repo/packages/app/.kimi-code/AGENTS.md -->',
    );
    expect(created.agent.config.systemPrompt).toContain('brand instructions');
    expect(created.agent.config.systemPrompt).toContain(
      '<!-- From: /repo/packages/app/AGENTS.md -->',
    );
    expect(created.agent.config.systemPrompt).toContain('leaf instructions');
  });

  it('uses the kimi home for global branded AGENTS.md files', async () => {
    const realHome = '/real-home';
    const kimiHome = '/kimi-home';
    const workDir = '/repo/packages/app';
    const kaos = createFakeKaos({
      gethome: () => realHome,
      mkdir: vi.fn(async () => {}),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if (['/repo', '/repo/.git', '/repo/packages', workDir].includes(path)) {
          return stat('dir');
        }
        if ([`${kimiHome}/AGENTS.md`, `${realHome}/.kimi-code/AGENTS.md`].includes(path)) {
          return stat('file');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      // oxlint-disable-next-line require-yield
      iterdir: async function* () {
        return;
      },
      readText: vi.fn(async (path: string) => {
        if (path === `${kimiHome}/AGENTS.md`) return 'kimi home instructions';
        if (path === `${realHome}/.kimi-code/AGENTS.md`) return 'stale real-home instructions';
        throw new Error(`ENOENT ${path}`);
      }),
    });
    const session = new Session({
      id: 'test-kimi-home-agents-md',
      kaos: kaos.withCwd(workDir),
      homedir: '/tmp/kimi-session',
      kimiHomeDir: kimiHome,
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const created = await session.createAgent({ type: 'main' }, { profile: contextProfile() });

    expect(created.agent.config.systemPrompt).toContain('kimi home instructions');
    expect(created.agent.config.systemPrompt).not.toContain('stale real-home instructions');
  });

  it('inherits the parent agent cwd when creating a subagent', async () => {
    const sessionWorkDir = '/session/work';
    const parentWorkDir = '/parent/work';

    const kaos = createFakeKaos({
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeText: vi.fn().mockResolvedValue(0),
      stat: vi.fn(async (path: string) => {
        if ([sessionWorkDir, parentWorkDir].includes(path)) {
          return stat('dir');
        }
        throw new Error(`ENOENT ${path}`);
      }),
      // oxlint-disable-next-line require-yield
      iterdir: async function* () {
        return;
      },
      getcwd: () => sessionWorkDir,
    });

    const session = new Session({
      id: 'test-subagent-parent-cwd',
      kaos,
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    // Create a parent agent — it should start at the session workDir.
    const parent = await session.createAgent({ type: 'main' }, { profile: contextProfile() });
    expect(parent.agent.config.systemPrompt).toContain(`cwd=${sessionWorkDir}`);

    // Move the parent agent to a different cwd (e.g. after a config.update replay).
    parent.agent.config.update({ cwd: parentWorkDir });

    // Create a subagent from the moved parent.
    const child = await session.createAgent(
      { type: 'sub' },
      { profile: contextProfile(), parentAgentId: parent.id },
    );

    // The subagent should inherit the parent's current cwd, not the session default.
    expect(child.agent.config.systemPrompt).toContain(`cwd=${parentWorkDir}`);
    expect(child.agent.config.systemPrompt).not.toContain(`cwd=${sessionWorkDir}`);
  });

  it('allocates the next unused generated agent id', async () => {
    const session = new Session({
      id: 'test-subagent-agent-id',
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });
    session.metadata.agents['agent-0'] = {
      homedir: '/tmp/kimi-session/agents/agent-0',
      type: 'sub',
      parentAgentId: null,
    };

    const created = await session.createAgent({ type: 'sub' });

    expect(created.id).toBe('agent-1');
    expect(session.agents.get('agent-1')).toBe(created.agent);
    expect(session.metadata.agents['agent-1']).toMatchObject({
      homedir: '/tmp/kimi-session/agents/agent-1',
      type: 'sub',
    });
  });

  it('shares the session McpConnectionManager with sub and main agents', async () => {
    const session = new Session({
      kaos: createFakeKaos({
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeText: vi.fn().mockResolvedValue(0),
      }),
      homedir: '/tmp/kimi-session',
      rpc: createSessionRpc(),
      initializeMainAgent: false,
    });

    const main = await session.createAgent({ type: 'main' });
    expect(main.agent.mcp).toBe(session.mcp);

    const sub = await session.createAgent({ type: 'sub' }, { parentAgentId: main.id });
    expect(sub.agent.mcp).toBe(session.mcp);
  });
});

function fakeSession(
  parent: Agent,
  child: Agent,
  metadataAgents: Session['metadata']['agents'] = {},
) {
  const agents = new Map<string, Agent>([['main', parent]]);
  if (metadataAgents['agent-0'] !== undefined) {
    agents.set('agent-0', child);
  }
  return {
    agents,
    options: { kimiHomeDir: undefined },
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: 'Test Session',
      isCustomTitle: false,
      agents: metadataAgents,
      custom: {},
    },
    writeMetadata: vi.fn(async () => {}),
    systemContextKaos: vi.fn((cwd: string) => parent.kaos.withCwd(cwd)),
    getReadyAgent: vi.fn((id: string) => agents.get(id)),
    ensureAgentResumed: vi.fn(async (id: string) => {
      const agent = agents.get(id);
      if (agent === undefined) {
        throw new Error(`Agent "${id}" was not found`);
      }
      return agent;
    }),
    createAgent: vi.fn(
      async (
        config: Parameters<Session['createAgent']>[0],
        options: Parameters<Session['createAgent']>[1] = {},
      ) => {
        agents.set('agent-0', child);
        const parentAgentId = options.parentAgentId ?? null;
        if (options.persistMetadata !== false) {
          metadataAgents['agent-0'] = {
            homedir: '/tmp/kimi-session/agents/agent-0',
            type: config.type ?? 'main',
            parentAgentId,
            swarmItem: options.swarmItem,
          };
        }
        if (options.profile !== undefined) {
          child.useProfile(options.profile);
        }
        return { id: 'agent-0', agent: child };
      },
    ),
  } as unknown as Session;
}

function contextProfile(): ResolvedAgentProfile {
  return {
    name: 'context-profile',
    systemPrompt: (context) =>
      [
        `cwd=${context.cwd}`,
        `listing=${context.cwdListing ?? ''}`,
        `agents=${context.agentsMd ?? ''}`,
      ].join('\n'),
    tools: [],
  };
}

function lookupToolRegistration() {
  return {
    name: 'Lookup',
    description: 'Look up a short test value.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };
}

function profile(input: {
  readonly name: string;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  readonly description?: string | undefined;
  readonly subagents?: Record<string, ResolvedAgentProfile> | undefined;
}): ResolvedAgentProfile {
  return {
    name: input.name,
    description: input.description,
    systemPrompt: () => input.systemPrompt,
    tools: [...input.tools],
    subagents: input.subagents,
  };
}

function stat(kind: 'dir' | 'file') {
  return {
    stMode: kind === 'dir' ? 0o040000 : 0o100000,
    stIno: 0,
    stDev: 0,
    stNlink: 1,
    stUid: 0,
    stGid: 0,
    stSize: 0,
    stAtime: 0,
    stMtime: 0,
    stCtime: 0,
  };
}

function queuedTask(index: number): QueuedSubagentTask<number> {
  return {
    kind: 'spawn',
    data: index,
    profileName: 'coder',
    parentToolCallId: 'call_swarm',
    prompt: `Review item-${String(index)}`,
    description: `Review #${String(index)}`,
    swarmIndex: index,
    runInBackground: false,
  };
}

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-text',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
    usage: {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

function userTextMessages(history: readonly Message[]): string[] {
  return history
    .filter((message) => message.role === 'user')
    .map((message) =>
      message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
    );
}

async function writeWire(homedir: string, records: readonly Record<string, unknown>[]) {
  await mkdir(homedir, { recursive: true });
  const wireRecords =
    records.length === 0
      ? []
      : [
          {
            type: 'metadata',
            protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
            created_at: 1,
          },
          ...records,
        ];
  const text = wireRecords.map((record) => JSON.stringify(record)).join('\n');
  await writeFile(join(homedir, 'wire.jsonl'), text.length === 0 ? '' : `${text}\n`, 'utf-8');
}

function childBashToolResultOutput(child: AgentTestContext): string | undefined {
  for (const entry of child.allEvents) {
    if (entry.type !== '[wire]' || entry.event !== 'context.append_loop_event') continue;
    const loopEvent = (
      entry.args as {
        event?: { type?: string; toolCallId?: string; result?: { output?: unknown } };
      }
    ).event;
    if (loopEvent?.type === 'tool.result' && loopEvent.toolCallId === 'call_bash') {
      const output = loopEvent.result?.output;
      return typeof output === 'string' ? output : undefined;
    }
  }
  return undefined;
}

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
      arguments: '{"command":"printf should-not-run","timeout":60}',
  };
}

function createSessionRpc(): SDKSessionRPC {
  return new Proxy(
    {},
    {
      get: () => vi.fn(),
    },
  ) as SDKSessionRPC;
}
