import { afterEach, describe, expect, it, vi } from 'vitest';

import { type CollectionView } from '#/_base/di/collection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IInstantiationService } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Event } from '#/_base/event';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { INHERITED_IN_FLIGHT_TOOL_OUTPUT } from '#/agent/contextMemory/openToolExchange';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
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
import { IAgentRuntimeBindingSeed } from '#/agent/runtimeBinding/runtimeBinding';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { WAIT_FOR_FLAG_ID } from '#/agent/tools/task/task-wait/flag';
import { IWebSearchProviderService } from '#/app/auth/webSearch/webSearch';
import { IFlagService } from '#/app/flag/flag';
import { ISessionNotify } from '#/features/notify/sessionNotify';
import { ISessionBtwService } from '#/features/btw/btw';
import { TOWER_WORKER_PROFILE } from '#/features/tower/tower';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { SUBAGENT_FORK_FLAG_ID } from '#/session/subagent/flag';
import {
  normalizeAgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { FORK_CONTEXT_NOTICE } from '#/session/subagent/spawn';
import { SUBAGENT_BACKGROUND_TASK_NOTICE } from '#/agent/task/taskService';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
  type WorkspaceInstanceChange,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

import {
  appService,
  agentServices,
  sessionServices,
  testAgent,
  type TestAgentContext,
} from '../../harness';
import { stubFlag } from '../../app/flag/stubs';

class ScopedAppendLogStore implements IAppendLogStore {
  declare readonly _serviceBrand: undefined;
  private readonly logs = new Map<string, WireRecord[]>();
  readonly onDidWrite: IAppendLogStore['onDidWrite'] = Event.None as IAppendLogStore['onDidWrite'];

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

  flushLog(): Promise<void> {
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
    @IHostTerminalService terminal: IHostTerminalService,
  ) {
    this.runtime = new LocalRuntime('test-workspace', environment, fs, processes, terminal);
  }

  inspect(_binding: RuntimeBinding): Runtime {
    return this.runtime;
  }

  acquire(_binding: RuntimeBinding, _required?: readonly RuntimeCapability[]): RuntimeLease {
    return { runtime: this.runtime, track: (resource) => resource, dispose: () => {} };
  }
}

class ToolContributions {
  constructor(@AgentToolContribution readonly view: CollectionView<AgentToolContribution>) {}
}

const SENT_ONLY_WITH_DYNAMIC_TOOL_LOADING: ReadonlySet<string> = new Set([SELECT_TOOLS_TOOL_NAME]);

const PARENT_SYSTEM_PROMPT = 'You are the parity probe parent.';
const ACTIVE_TOOL_NAMES = ['Agent', 'Bash', 'Read'];
const CHILD_FINAL_TEXT = 'The inherited task is done.';

function taskReminders(history: readonly Pick<ContextMessage, 'content'>[]): string[] {
  return history.flatMap((message) => message.content).flatMap((part) =>
    part.type === 'text' && part.text.includes(SUBAGENT_BACKGROUND_TASK_NOTICE) ? [part.text] : [],
  );
}

describe('subagent task reminders and fork request parity', () => {
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
      sessionServices((reg) => {
        reg.defineDescriptor(IRuntimeResolver, new SyncDescriptor(TestRuntimeResolver));
        reg.definePartialInstance(IWorkspaceInstanceManager, {
          onDidChange: Event.None as Event<WorkspaceInstanceChange>,
          get: () => undefined,
        });
      }),
    );

    const agentLifecycle = ctx.get(IAgentLifecycleService);
    const parentContext = await agentLifecycle.create({ agentId: 'parent' });
    const parent = agentLifecycle.handleOf(parentContext.agentId)!;
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

    const loop = parent.accessor.get(IAgentLoopService);
    const { id } = loop.submit({
      message: { role: 'user', content: [{ type: 'text', text: 'start the parity probe' }] },
      meta: { origin: { kind: 'user' }, tracked: true },
    });
    const completion = await loop.promptHandle(id)!.completion;
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
    expect(tail.map((message) => message.role)).toEqual(['assistant', 'tool', 'user', 'user']);
    expect(tail[0]?.toolCalls.map((call) => call.name)).toEqual(['Agent']);
    expect(tail[0]?.partial).toBeUndefined();
    expect(tail[1]?.toolCallId).toBe('call_fork');
    expect(tail[1]?.content).toEqual([{ type: 'text', text: INHERITED_IN_FLIGHT_TOOL_OUTPUT }]);
    const notice = tail[2]?.content[0];
    expect(notice?.type).toBe('text');
    expect(notice?.type === 'text' && notice.text).toBe(wrapSystemReminder(FORK_CONTEXT_NOTICE));
    const prompt = tail[3]?.content[0];
    expect(prompt?.type).toBe('text');
    expect(prompt?.type === 'text' && prompt.text).toBe('finish the inherited task');

    expect(parentFollowup.history.slice(0, parentReq.history.length)).toEqual(parentReq.history);
    expect(parentFollowup.history[parentReq.history.length]).toEqual(tail[0]);

    const childId = agentLifecycle
      .list()
      .map((agent) => agent.agentId)
      .find((id) => id !== 'parent' && id !== 'main');
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

  function createMainForkCtx(flags: IFlagService = stubFlag(true)): void {
    store = new ScopedAppendLogStore();
    ctx = testAgent(
      appService(IAppendLogStore, store),
      appService(IFlagService, flags),
      appService(IWebSearchProviderService, {
        _serviceBrand: undefined,
        hasWebSearchProvider: () => true,
        getWebSearchProvider: () => ({ search: () => Promise.resolve([]) }),
      }),
      sessionServices((reg) => {
        reg.defineDescriptor(IRuntimeResolver, new SyncDescriptor(TestRuntimeResolver));
        reg.definePartialInstance(IWorkspaceInstanceManager, {
          onDidChange: Event.None as Event<WorkspaceInstanceChange>,
          get: () => undefined,
        });
        reg.defineInstance(ISessionNotify, {
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          enabled: true,
        });
      }),
      agentServices((reg) => {
        reg.defineInstance(IAgentRuntimeBindingSeed, {
          _serviceBrand: undefined,
          binding: { workspaceId: 'test-workspace', runtimeId: 'local' },
        });
      }),
    );
  }

  async function createDirectChild(profile = 'coder'): Promise<IAgentScopeHandle> {
    const lifecycle = ctx.get(IAgentLifecycleService);
    const child = await lifecycle.create({
      agentId: 'direct-child',
      binding: { profile, model: 'mock-model' },
    });
    return lifecycle.handleOf(child.agentId)!;
  }

  async function runPrompt(agent: IAgentScopeHandle): Promise<void> {
    ctx.mockNextResponse({ type: 'text', text: CHILD_FINAL_TEXT });
    const loop = agent.accessor.get(IAgentLoopService);
    const { id } = loop.submit({
      message: { role: 'user', content: [{ type: 'text', text: 'continue the task' }] },
      meta: { origin: { kind: 'user' }, tracked: true },
    });
    expect((await loop.promptHandle(id)!.completion).state).toBe('completed');
  }

  async function runMainAgentFork(options?: { readonly disallowedTools?: readonly string[] }): Promise<void> {
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: 'agent', model: 'mock-model' });
    profile.update({ activeToolNames: contributedToolNames() });
    if (options?.disallowedTools !== undefined) {
      profile.update({ disallowedTools: [...options.disallowedTools] });
    }
    ctx.get(IAgentPermissionModeService).setMode('yolo');

    ctx.mockNextResponse({
      type: 'function',
      id: 'call_fork',
      name: 'Agent',
      arguments: JSON.stringify({
        description: 'main fork parity child',
        prompt: 'finish the inherited task',
        fork: true,
      }),
    });
    ctx.mockNextResponse({ type: 'text', text: CHILD_FINAL_TEXT });
    ctx.mockNextResponse({ type: 'text', text: 'parent final answer' });

    const loop = ctx.get(IAgentLoopService);
    const { id } = loop.submit({
      message: { role: 'user', content: [{ type: 'text', text: 'start the main fork probe' }] },
      meta: { origin: { kind: 'user' }, tracked: true },
    });
    const completion = await loop.promptHandle(id)!.completion;
    expect(completion.state).toBe('completed');
  }

  function contributedToolNames(): string[] {
    return ctx
      .get(IInstantiationService)
      .createInstance<ToolContributions>(new SyncDescriptor(ToolContributions))
      .view.items.map((contribution) => contribution.options.name);
  }

  function expectMainForkParity(): void {
    expect(ctx.llmCalls).toHaveLength(3);
    const parentReq = ctx.llmCalls[0]!;
    const childReq = ctx.llmCalls[1]!;

    expect(taskReminders(parentReq.history)).toHaveLength(0);
    expect(childReq.systemPrompt).toBe(parentReq.systemPrompt);
    expect(parentReq.tools.map((tool) => tool.name).toSorted()).toEqual(
      contributedToolNames()
        .filter((name) => !SENT_ONLY_WITH_DYNAMIC_TOOL_LOADING.has(name))
        .toSorted(),
    );
    expect(childReq.tools).toEqual(parentReq.tools);

    const prefix = childReq.history.slice(0, parentReq.history.length);
    expect(prefix).toEqual(parentReq.history);

    const tailText = childReq.history
      .slice(parentReq.history.length)
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(tailText).toContain(SUBAGENT_BACKGROUND_TASK_NOTICE);
  }

  it('keeps first-request parity when the main agent forks', async () => {
    createMainForkCtx();
    await runMainAgentFork();
    expectMainForkParity();
  });

  it('keeps first-request parity when discovered profiles exist', async () => {
    createMainForkCtx();
    ctx.get(IAgentProfileRegistry).register({
      sourceId: 'workspace',
      priority: 30,
      contribution: {
        profiles: [
          normalizeAgentProfile({
            name: 'code-reviewer',
            description: 'Reviews code changes for regressions.',
            tools: ['Read', 'Grep', 'Glob'],
            systemPrompt: () => 'You are a code reviewer.',
          }),
        ],
      },
    });
    await runMainAgentFork();

    const parentReq = ctx.llmCalls[0]!;
    const agentTool = parentReq.tools.find((tool) => tool.name === 'Agent');
    expect(agentTool?.description).toContain('code-reviewer');
    expectMainForkParity();
  });

  it('omits the background-task reminder when WaitFor is vetoed', async () => {
    createMainForkCtx();
    await runMainAgentFork({ disallowedTools: ['WaitFor'] });

    expect(ctx.llmCalls).toHaveLength(3);
    const parentReq = ctx.llmCalls[0]!;
    const childReq = ctx.llmCalls[1]!;
    expect(childReq.tools).toEqual(parentReq.tools);

    const tailText = childReq.history
      .slice(parentReq.history.length)
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(tailText).not.toContain(SUBAGENT_BACKGROUND_TASK_NOTICE);
  });

  it.each(['coder', TOWER_WORKER_PROFILE])(
    'keeps guidance across steps and turns for a directly created %s',
    async (profile) => {
      createMainForkCtx();
      const child = await createDirectChild(profile);
      child.accessor.get(IAgentPermissionModeService).setMode('yolo');
      ctx.mockNextResponse({
        type: 'function',
        id: 'call_wait',
        name: 'WaitFor',
        arguments: JSON.stringify({ timeout: 1 }),
      });

      await runPrompt(child);
      await runPrompt(child);

      expect(ctx.llmCalls).toHaveLength(3);
      for (const request of ctx.llmCalls) {
        expect(request.tools.some((tool) => tool.name === 'WaitFor')).toBe(true);
        expect(taskReminders(request.history)).toEqual([wrapSystemReminder(SUBAGENT_BACKGROUND_TASK_NOTICE)]);
      }
      expect(taskReminders(child.accessor.get(IAgentContextMemoryService).get())).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'restores a child with a persisted reminder=%s without losing or duplicating guidance',
    async (hasReminder) => {
      createMainForkCtx();
      const original = await createDirectChild();
      original.accessor.get(IAgentContextMemoryService).append({
        role: 'user',
        content: [{ type: 'text', text: 'task from the previous session' }],
        toolCalls: [],
        origin: { kind: 'user' },
      });
      if (hasReminder) {
        original.accessor.get(IAgentReminderService).notify(SUBAGENT_BACKGROUND_TASK_NOTICE, {
          variant: 'subagent_background_task',
        });
      }
      const lifecycle = ctx.get(IAgentLifecycleService);
      const originalContext = lifecycle.get(original.id)!;
      await lifecycle.remove(originalContext);
      const restoredContext = await lifecycle.create({ agentId: original.id });
      const restored = lifecycle.handleOf(restoredContext.agentId)!;
      expect(restoredContext.generation).not.toBe(originalContext.generation);
      expect(restored.accessor.get(IAgentProfileService).data().profileName).toBe('coder');
      const history = restored.accessor.get(IAgentContextMemoryService).get();
      expect(taskReminders(history)).toHaveLength(hasReminder ? 1 : 0);

      await runPrompt(restored);

      expect(taskReminders(ctx.llmCalls[0]!.history)).toHaveLength(1);
      expect(restored.accessor.get(IAgentContextMemoryService).get().slice(0, history.length)).toEqual(history);
    },
  );

  it.each([false, true])(
    're-injects after compaction, including inside the next step hook chain=%s',
    async (insideStep) => {
      createMainForkCtx();
      const child = await createDirectChild();
      const context = child.accessor.get(IAgentContextMemoryService);
      await runPrompt(child);
      expect(taskReminders(context.get())).toHaveLength(1);
      const compact = (): void => {
        context.applyCompaction({
          summary: 'The child still needs to finish the task.',
          compactedCount: context.get().length,
          tokensBefore: 1000,
        });
        expect(taskReminders(context.get())).toHaveLength(0);
      };
      if (insideStep) {
        child.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register(
          'test-compaction',
          async (_step, next) => {
            compact();
            await next();
          },
          { after: 'context-injector' },
        );
      } else {
        compact();
      }

      await runPrompt(child);

      expect(ctx.llmCalls).toHaveLength(2);
      expect(taskReminders(ctx.llmCalls[1]!.history)).toHaveLength(1);
      expect(taskReminders(context.get())).toHaveLength(1);
    },
  );

  it.each(['flag', 'profile', 'session'] as const)(
    'omits guidance when the registered WaitFor tool is disabled by %s',
    async (restriction) => {
      let waitForEnabled = true;
      createMainForkCtx(stubFlag((id) => id !== WAIT_FOR_FLAG_ID || waitForEnabled));
      const child = await createDirectChild();
      expect(child.accessor.get(IAgentToolRegistryService).resolve('WaitFor')).toBeDefined();
      if (restriction === 'flag') {
        waitForEnabled = false;
      } else if (restriction === 'profile') {
        child.accessor.get(IAgentProfileService).update({ disallowedTools: ['WaitFor'] });
      } else {
        await child.accessor.get(IAgentToolPolicyService).setSessionDisabledTools(['WaitFor']);
      }

      await runPrompt(child);

      expect(taskReminders(ctx.llmCalls[0]!.history)).toHaveLength(0);
    },
  );

  it('waits for WaitFor activation instead of deciding availability when the agent is created', async () => {
    let waitForEnabled = false;
    createMainForkCtx(stubFlag((id) => id !== WAIT_FOR_FLAG_ID || waitForEnabled));
    const child = await createDirectChild();
    waitForEnabled = true;
    expect(child.accessor.get(IAgentToolRegistryService).resolve('WaitFor')).toBeUndefined();

    await runPrompt(child);

    expect(taskReminders(ctx.llmCalls[0]!.history)).toHaveLength(0);
    await child.accessor.get(IAgentToolActivationService).activate();
    await runPrompt(child);
    expect(taskReminders(ctx.llmCalls[1]!.history)).toHaveLength(1);
  });

  it('does not evaluate unrelated tool descriptions when checking WaitFor availability', async () => {
    createMainForkCtx();
    const child = await createDirectChild();
    const list = vi.spyOn(child.accessor.get(IAgentToolRegistryService), 'list');

    await child.accessor.get(IAgentReminderService).reconcileWhenIdle('subagent_background_task');

    expect(list).not.toHaveBeenCalled();
    expect(taskReminders(child.accessor.get(IAgentContextMemoryService).get())).toHaveLength(1);
  });

  it('keeps btw system, tools and inherited history identical to main', async () => {
    createMainForkCtx();
    await ctx.get(IAgentProfileService).bind({ profile: 'agent', model: 'mock-model' });
    ctx.get(IAgentProfileService).update({ activeToolNames: contributedToolNames() });
    const lifecycle = ctx.get(IAgentLifecycleService);
    await runPrompt(lifecycle.handleOf('main')!);
    const childId = await ctx.get(ISessionBtwService).start();
    const child = lifecycle.handleOf(childId)!;

    await runPrompt(child);

    const parentReq = ctx.llmCalls[0]!;
    const childReq = ctx.llmCalls[1]!;
    expect(parentReq.tools.some((tool) => tool.name === 'WaitFor')).toBe(true);
    expect(childReq.tools).toEqual(parentReq.tools);
    expect(childReq.systemPrompt).toBe(parentReq.systemPrompt);
    expect(childReq.history.slice(0, parentReq.history.length)).toEqual(parentReq.history);
    expect(ctx.llmCalls).toHaveLength(2);
  });
});
