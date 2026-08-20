import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import { INHERITED_IN_FLIGHT_TOOL_OUTPUT } from '#/agent/contextMemory/openToolExchange';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IHostTerminalService } from '#/os/interface/terminal';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { LocalRuntime } from '#/runtime/localRuntime';
import type {
  Runtime,
  RuntimeBinding,
  RuntimeCapability,
  RuntimeLease,
} from '#/runtime/runtime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentLifecycleService } from '#/session/agentLifecycle/agentLifecycleService';
import { IFlagService } from '#/app/flag/flag';
import { SUBAGENT_FORK_FLAG_ID } from '#/session/subagent/flag';
import { FORK_CONTEXT_NOTICE } from '#/session/subagent/spawn';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
  type WorkspaceInstanceChange,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

import {
  appService,
  sessionService,
  sessionServices,
  testAgent,
  type TestAgentContext,
} from '../../harness';
import { stubFlag } from '../../app/flag/stubs';

class ScopedAppendLogStore implements IAppendLogStore {
  declare readonly _serviceBrand: undefined;
  private readonly logs = new Map<string, WireRecord[]>();

  recordsFor(scope: string, key: string): WireRecord[] {
    return structuredClone(this.logs.get(`${scope}/${key}`) ?? []);
  }

  append<R>(scope: string, key: string, record: R): void {
    const id = `${scope}/${key}`;
    const records = this.logs.get(id) ?? [];
    records.push(structuredClone(record) as WireRecord);
    this.logs.set(id, records);
  }

  async *read<R>(scope: string, key: string): AsyncIterable<R> {
    for (const record of this.logs.get(`${scope}/${key}`) ?? []) {
      yield structuredClone(record) as R;
    }
  }

  rewrite<R>(scope: string, key: string, records: readonly R[]): Promise<void> {
    this.logs.set(
      `${scope}/${key}`,
      records.map((record) => structuredClone(record) as WireRecord),
    );
    return Promise.resolve();
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  acquire(): IDisposable {
    return { dispose: () => {} };
  }

  drainRetirements(): Promise<void> {
    return Promise.resolve();
  }
}

class TestRuntimeResolver implements IRuntimeResolver {
  declare readonly _serviceBrand: undefined;
  private readonly runtime: LocalRuntime;

  constructor(
    @IHostEnvironment environment: IHostEnvironment,
    @IHostFileSystem fs: IHostFileSystem,
    @IHostProcessService processes: IHostProcessService,
    @IHostFsWatchService watch: IHostFsWatchService,
    @IHostTerminalService terminal: IHostTerminalService,
  ) {
    this.runtime = new LocalRuntime('test-workspace', environment, fs, processes, watch, terminal);
  }

  inspect(_binding: RuntimeBinding): Runtime {
    return this.runtime;
  }

  acquire(_binding: RuntimeBinding, _required?: readonly RuntimeCapability[]): RuntimeLease {
    return { runtime: this.runtime, track: (resource) => resource, dispose: () => {} };
  }
}

const PARENT_SYSTEM_PROMPT = 'You are the parity probe parent.';
const ACTIVE_TOOL_NAMES = ['Agent', 'Bash', 'Read'];
const CHILD_FINAL_TEXT =
  'The inherited task is done. This closing summary is intentionally long so that any ' +
  'profile summary policy with a minimum character threshold considers it adequate and no ' +
  'extra continuation request is scripted for the child agent turn.';

describe('fork subagent first-request parity', () => {
  let ctx: TestAgentContext;
  let store: ScopedAppendLogStore;

  afterEach(async () => {
    await ctx.dispose();
  });

  it('keeps system prompt, tools and history prefix identical to the parent first request', async () => {
    store = new ScopedAppendLogStore();
    ctx = testAgent(
      appService(IAppendLogStore, store),
      appService(IFlagService, stubFlag((id) => id === SUBAGENT_FORK_FLAG_ID)),
      sessionService(IAgentLifecycleService, new SyncDescriptor(AgentLifecycleService)),
      sessionServices((reg) => {
        reg.defineDescriptor(IRuntimeResolver, new SyncDescriptor(TestRuntimeResolver));
        reg.definePartialInstance(IWorkspaceInstanceManager, {
          onDidChange: Event.None as Event<WorkspaceInstanceChange>,
          get: () => undefined,
        });
      }),
    );

    const lifecycle = ctx.get(IAgentLifecycleService);
    const parent = await lifecycle.create({ agentId: 'parent' });
    const profile = parent.accessor.get(IAgentProfileService);
    profile.update({
      modelAlias: 'mock-model',
      systemPrompt: PARENT_SYSTEM_PROMPT,
      thinkingLevel: 'off',
    });
    profile.update({ activeToolNames: [...ACTIVE_TOOL_NAMES] });
    parent.accessor.get(IAgentPermissionModeService).setMode('yolo');

    ctx.mockNextResponse({
      type: 'function',
      id: 'call_fork',
      name: 'Agent',
      arguments: JSON.stringify({
        description: 'fork parity child',
        prompt: 'finish the inherited task',
        fork: true,
      }),
    });
    ctx.mockNextResponse({ type: 'text', text: CHILD_FINAL_TEXT });
    ctx.mockNextResponse({ type: 'text', text: 'parent final answer' });

    const handle = await parent.accessor.get(IAgentPromptService).enqueue({
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'start the parity probe' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    const completion = await handle.completion;
    expect(completion.state).toBe('completed');

    expect(ctx.llmCalls).toHaveLength(3);
    const parentReq = ctx.llmCalls[0]!;
    const childReq = ctx.llmCalls[1]!;
    const parentFollowup = ctx.llmCalls[2]!;

    expect(childReq.systemPrompt).toBe(PARENT_SYSTEM_PROMPT);
    expect(childReq.systemPrompt).toBe(parentReq.systemPrompt);

    expect(parentReq.tools.map((tool) => tool.name)).toEqual([...ACTIVE_TOOL_NAMES].toSorted());
    expect(childReq.tools).toEqual(parentReq.tools);

    const prefix = childReq.history.slice(0, parentReq.history.length);
    expect(prefix).toEqual(parentReq.history);

    const tail = childReq.history.slice(parentReq.history.length);
    expect(tail.map((message) => message.role)).toEqual(['assistant', 'tool', 'user']);
    expect(tail[0]?.toolCalls.map((call) => call.name)).toEqual(['Agent']);
    expect(tail[0]?.partial).toBeUndefined();
    expect(tail[1]?.toolCallId).toBe('call_fork');
    expect(tail[1]?.content).toEqual([{ type: 'text', text: INHERITED_IN_FLIGHT_TOOL_OUTPUT }]);
    const notice = tail[2]?.content[0];
    expect(notice?.type).toBe('text');
    expect(notice?.type === 'text' && notice.text.startsWith(FORK_CONTEXT_NOTICE)).toBe(true);

    expect(parentFollowup.history.slice(0, parentReq.history.length)).toEqual(parentReq.history);
    expect(parentFollowup.history[parentReq.history.length]).toEqual(tail[0]);

    const childId = lifecycle
      .list()
      .map((agent) => agent.id)
      .find((id) => id !== 'parent');
    expect(childId).toBeDefined();
    const scopeOf = (agentId: string) =>
      `sessions/test-workspace/test-session/agents/${agentId}`;
    const firstLlmRequest = (agentId: string): WireRecord | undefined =>
      store
        .recordsFor(scopeOf(agentId), AGENT_WIRE_RECORD_KEY)
        .find((record) => record.type === 'llm.request');
    const parentWire = firstLlmRequest('parent');
    const childWire = firstLlmRequest(childId!);
    expect(parentWire).toBeDefined();
    expect(childWire).toBeDefined();
    expect(childWire).toMatchObject({
      model: parentWire?.['model'],
      modelAlias: parentWire?.['modelAlias'],
      thinkingEffort: parentWire?.['thinkingEffort'],
      systemPromptHash: parentWire?.['systemPromptHash'],
      toolsHash: parentWire?.['toolsHash'],
    });
  });
});
