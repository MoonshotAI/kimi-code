import { createControlledPromise } from '@antfu/utils';
import { appendContext, compactContext } from '../../agent/contextMemory/stubs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { userCancellationReason } from '#/_base/utils/abort';
import { type CollectionView } from '#/_base/di/collection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IInstantiationService } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Event } from '#/_base/event';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { INHERITED_IN_FLIGHT_TOOL_OUTPUT } from '#/agent/contextMemory/openToolExchange';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentTaskService } from '#/agent/task/task';
import type { LlmMessageContent } from '@moonshot-ai/core/llm/request';
import type { MockProvider } from '../../harness/scripted-generate';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { LocalEnvironment } from '#/environment/localEnvironment';
import type {
  Environment,
  EnvironmentBinding,
  EnvironmentCapability,
  EnvironmentLease,
} from '#/environment/environment';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolSelectService, SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
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
const SUBAGENT_BACKGROUND_TASK_NOTICE =
  'You are running as a subagent: ending your turn is your final hand-off to the parent agent, and completion notifications that arrive after it reach no one. Do not end your turn while a background task whose result you need is still running. Keep waiting for it with WaitFor, calling it again after a timeout if needed, or run the command in the foreground with a suitable timeout instead. Still use the waiting time for other useful work on your task when you can.';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { IWorkspaceInstanceManager, type WorkspaceInstanceChange } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';

import {
  appService,
  agentServices,
  createMockProvider,
  createScriptedGenerate,
  llmGenerateServices,
  sessionServices,
  telemetryServices,
  testAgent,
  type TestAgentContext,
} from '../../harness';
import { stubFlag } from '../../app/flag/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

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

  externallyModified(): boolean {
    return false;
  }

  bindWriteGuard(): IDisposable {
    return { dispose: () => undefined };
  }
}

class TestEnvironmentResolver implements EnvironmentResolver {
  readonly onDidChange = () => ({ dispose: () => {} });
  declare readonly _serviceBrand: undefined;
  private readonly environment: LocalEnvironment;

  constructor(
    @IHostEnvironment environment: IHostEnvironment,
    @IHostFileSystem fs: IHostFileSystem,
    @IHostProcessService processes: IHostProcessService,
  ) {
    this.environment = new LocalEnvironment(environment, fs, processes);
  }

  inspect(_binding: EnvironmentBinding): Environment {
    return this.environment;
  }

  acquire(_binding: EnvironmentBinding, _required?: readonly EnvironmentCapability[]): EnvironmentLease {
    return { environment: this.environment, track: (resource) => resource, dispose: () => {} };
  }

  acquireWhenReady(_binding: EnvironmentBinding, _required?: readonly EnvironmentCapability[]): Promise<EnvironmentLease> {
    return Promise.resolve({ environment: this.environment, track: (resource) => resource, dispose: () => {} });
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

const STOPPED_CHILD_PROMPT = 'Find why the parser never terminates.';
const STOPPED_CHILD_FINDING = '已定位 src/parser.ts:42 的循环条件，尚未执行验证。';
const STOPPED_CHILD_DRAFT = 'Drafting the report: the loop never advances 🔁';

function requestTexts(content: LlmMessageContent, role?: string): string[] {
  return content.messages
    .filter((message) => role === undefined || message.role === role)
    .flatMap((message) => message.content)
    .flatMap((part) => (part.type === 'text' ? [part.text] : []));
}

async function waitForAbortReason(signal: AbortSignal): Promise<unknown> {
  if (!signal.aborted) {
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

describe('subagent task reminders and fork request parity', () => {
  let ctx: TestAgentContext;
  let store: ScopedAppendLogStore;

  afterEach(async () => {
    await ctx.dispose();
  });

  it('keeps system prompt, tools and history prefix identical to the parent first request', async () => {
    store = new ScopedAppendLogStore();
    const telemetry: TelemetryRecord[] = [];
    ctx = testAgent(
      appService(IAppendLogStore, store),
      appService(IFlagService, stubFlag((id) => id === SUBAGENT_FORK_FLAG_ID)),
      telemetryServices(recordingTelemetry(telemetry)),
      sessionServices((reg) => {
        reg.defineDescriptor(IEnvironmentService, new SyncDescriptor(TestEnvironmentResolver));
        reg.definePartialInstance(IWorkspaceInstanceManager, {
          onDidChange: Event.None as Event<WorkspaceInstanceChange>,
          get: () => undefined,
        });
      }),
    );

    const agentLifecycle = ctx.get(IAgentLifecycleService);
    const parentContext = await agentLifecycle.create({
      agentId: 'parent',
      initialProfile: {
        modelAlias: 'mock-model',
        systemPrompt: PARENT_SYSTEM_PROMPT,
        thinkingLevel: 'off',
        activeToolNames: [...ACTIVE_TOOL_NAMES],
        disallowedTools: [],
      },
    });
    const parent = agentLifecycle.handleOf(parentContext.agentId)!;
    const profile = parent.accessor.get(IAgentLoopService);
    expect(profile.data().activeToolNames).toEqual([...ACTIVE_TOOL_NAMES]);
    expect(parent.accessor.get(IAgentToolSelectService).initialTools().map((tool) => tool.name))
      .toEqual([...ACTIVE_TOOL_NAMES].toSorted());
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
      meta: { origin: { kind: 'user' } },
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
    const assistant = tail[0];
    const toolResult = tail[1];
    if (assistant?.role !== 'assistant' || toolResult?.role !== 'tool') {
      throw new Error('expected inherited assistant tool exchange');
    }
    expect(assistant.toolCalls.map((call) => call.name)).toEqual(['Agent']);
    expect('partial' in assistant ? assistant.partial : undefined).toBeUndefined();
    expect(toolResult.toolCallId).toBe('call_fork');
    expect(toolResult.content).toEqual([{ type: 'text', text: INHERITED_IN_FLIGHT_TOOL_OUTPUT }]);
    const prompt = tail[2]?.content[0];
    expect(prompt?.type).toBe('text');
    expect(prompt?.type === 'text' && prompt.text).toBe('finish the inherited task');
    const notice = tail[3]?.content[0];
    expect(notice?.type).toBe('text');
    expect(notice?.type === 'text' && notice.text).toBe(wrapSystemReminder(FORK_CONTEXT_NOTICE));

    expect(parentFollowup.history.slice(0, parentReq.history.length)).toEqual(parentReq.history);
    expect(parentFollowup.history[parentReq.history.length]).toEqual(tail[0]);

    const childId = agentLifecycle
      .list()
      .map((agent) => agent.agentId)
      .find((id) => id !== 'parent' && id !== 'main');
    expect(childId).toBeDefined();
    const probes = telemetry.filter((record) => record.event === 'prompt_cache_probe');
    expect(probes).toHaveLength(1);
    expect(probes[0]?.properties).toMatchObject({
      agent_id: childId,
      source: 'fork',
    });
    expect(probes[0]?.properties?.['tools_match']).toBeUndefined();
    expect(probes[0]?.properties?.['system_prompt_match']).toBeUndefined();
    expect(probes[0]?.properties?.['parent_input_tokens']).toBeUndefined();
  });

  function createMainForkCtx(
    flags: IFlagService = stubFlag(true),
    telemetry: TelemetryRecord[] = [],
    requester?: MockProvider,
  ): void {
    store = new ScopedAppendLogStore();
    ctx = testAgent(
      requester === undefined ? [] : llmGenerateServices(requester),
      appService(IAppendLogStore, store),
      appService(IFlagService, flags),
      appService(IWebSearchProviderService, {
        _serviceBrand: undefined,
        hasWebSearchProvider: () => true,
        getWebSearchProvider: () => ({ search: () => Promise.resolve([]) }),
      }),
      telemetryServices(recordingTelemetry(telemetry)),
      sessionServices((reg) => {
        reg.defineDescriptor(IEnvironmentService, new SyncDescriptor(TestEnvironmentResolver));
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
      meta: { origin: { kind: 'user' } },
    });
    expect((await loop.promptHandle(id)!.completion).state).toBe('completed');
  }

  async function runMainAgentFork(options?: { readonly disallowedTools?: readonly string[] }): Promise<void> {
    const profile = ctx.get(IAgentLoopService);
    await ctx.get(IAgentLoopService).bindProfile({ profile: 'agent', model: 'mock-model' });
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
      meta: { origin: { kind: 'user' } },
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
      expect(taskReminders(child.accessor.get(IAgentLoopService).history())).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'restores a child with a persisted reminder=%s without losing or duplicating guidance',
    async (hasReminder) => {
      createMainForkCtx();
      const original = await createDirectChild();
      appendContext(original.accessor.get(IAgentLoopService),{
        role: 'user',
        content: [{ type: 'text', text: 'task from the previous session' }],
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
      expect(
        store
          .recordsFor('sessions/test-workspace/test-session/agents/direct-child', AGENT_WIRE_RECORD_KEY)
          .some((record) =>
            record.type === 'context.append_message' &&
            JSON.stringify(record).includes(SUBAGENT_BACKGROUND_TASK_NOTICE)
          ),
      ).toBe(hasReminder);
      const restoredContext = await lifecycle.create({ agentId: original.id });
      const restored = lifecycle.handleOf(restoredContext.agentId)!;
      expect(restoredContext.generation).not.toBe(originalContext.generation);
      expect(restored.accessor.get(IAgentLoopService).data().profileName).toBe('coder');
      const history = restored.accessor.get(IAgentLoopService).history();
      expect(taskReminders(history)).toHaveLength(hasReminder ? 1 : 0);

      await runPrompt(restored);

      expect(taskReminders(ctx.llmCalls[0]!.history)).toHaveLength(1);
      expect(restored.accessor.get(IAgentLoopService).history().slice(0, history.length)).toEqual(history);
    },
  );

  it.each([false, true])(
    're-injects after compaction, including inside the next step hook chain=%s',
    async (insideStep) => {
      createMainForkCtx();
      const child = await createDirectChild();
      const context = child.accessor.get(IAgentLoopService);
      await runPrompt(child);
      expect(taskReminders(context.history())).toHaveLength(1);
      const compact = (): void => {
        compactContext(context,{
          summary: 'The child still needs to finish the task.',
          compactedCount: context.history().length,
          tokensBefore: 1000,
        });
        expect(taskReminders(context.history())).toHaveLength(0);
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
      expect(taskReminders(context.history())).toHaveLength(1);
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
        child.accessor.get(IAgentLoopService).update({ disallowedTools: ['WaitFor'] });
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
    expect(taskReminders(child.accessor.get(IAgentLoopService).history())).toHaveLength(1);
  });

  it('keeps btw system, tools and inherited history identical to main', async () => {
    createMainForkCtx();
    await ctx.get(IAgentLoopService).bindProfile({ profile: 'agent', model: 'mock-model' });
    ctx.get(IAgentLoopService).update({ activeToolNames: contributedToolNames() });
    const lifecycle = ctx.get(IAgentLifecycleService);
    const main = lifecycle.handleOf('main')!;
    main.accessor.get(IAgentPermissionModeService).setMode('yolo');
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_write',
      name: 'Write',
      arguments: JSON.stringify({ path: '/tmp/fork-tool-result-note.txt', content: 'probe' }),
    });
    await runPrompt(main);
    const projectedToolResult = main.accessor.get(IAgentLoopService).history()
      .find((message) => message.role === 'tool' && message.toolCallId === 'call_write');
    expect(projectedToolResult?.note).toBeDefined();
    expect(projectedToolResult?.content.some((part) => part.type === 'text' && part.text.includes('<system>'))).toBe(false);
    main.accessor.get(IAgentLoopService).update({ activeToolNames: ['Read', 'Grep', 'Glob'] });
    const childId = await ctx.get(ISessionBtwService).start();
    const child = lifecycle.handleOf(childId)!;

    await runPrompt(child);

    const childToolResult = child.accessor.get(IAgentLoopService).history()
      .find((message) => message.role === 'tool' && message.toolCallId === 'call_write');
    expect(childToolResult?.note).toBeDefined();
    expect(childToolResult?.content.some((part) => part.type === 'text' && part.text.includes('<system>'))).toBe(false);

    const parentReq = ctx.llmCalls[1]!;
    const childReq = ctx.llmCalls[2]!;
    expect(parentReq.tools.some((tool) => tool.name === 'WaitFor')).toBe(true);
    const parentToolResult = parentReq.history.find((message) => message.role === 'tool' && message.toolCallId === 'call_write');
    expect(parentToolResult?.content.some((part) => part.type === 'text' && part.text.includes('<system>'))).toBe(true);
    expect(childReq.tools).toEqual(parentReq.tools);
    expect(childReq.systemPrompt).toBe(parentReq.systemPrompt);
    expect(childReq.history.slice(0, parentReq.history.length)).toEqual(parentReq.history);
    expect(ctx.llmCalls).toHaveLength(3);
  });

  it('keeps btw cache probes usage-driven when main compacts', async () => {
    const telemetry: TelemetryRecord[] = [];
    createMainForkCtx(stubFlag(true), telemetry);
    await ctx.get(IAgentLoopService).bindProfile({ profile: 'agent', model: 'mock-model' });
    ctx.get(IAgentLoopService).update({ activeToolNames: contributedToolNames() });
    const lifecycle = ctx.get(IAgentLifecycleService);
    const main = lifecycle.handleOf('main')!;
    await runPrompt(main);

    const beforeCompaction = await ctx.get(ISessionBtwService).start();
    await runPrompt(lifecycle.handleOf(beforeCompaction)!);
    const context = main.accessor.get(IAgentLoopService);
    compactContext(context,{
      summary: 'The main agent still needs to finish the task.',
      compactedCount: context.history().length,
      tokensBefore: 1000,
    });
    const afterCompaction = await ctx.get(ISessionBtwService).start();
    await runPrompt(lifecycle.handleOf(afterCompaction)!);

    const probes = telemetry
      .filter((record) => record.event === 'prompt_cache_probe')
      .map((record) => record.properties ?? {});
    expect(probes.map((probe) => probe['agent_id'])).toEqual([beforeCompaction, afterCompaction]);
    for (const probe of probes) {
      expect(probe).toMatchObject({ source: 'fork' });
      expect(probe['tools_match']).toBeUndefined();
      expect(probe['system_prompt_match']).toBeUndefined();
      expect(probe['parent_input_tokens']).toBeUndefined();
      expect(probe['parent_request_gap_ms']).toBeUndefined();
    }
  });

  it('hands a stopped background subagent its run text back through TaskStop without extra requests', async () => {
    const parentScript = createScriptedGenerate();
    const childScript = createScriptedGenerate();
    const childStreaming = createControlledPromise<void>();
    let childRequests = 0;
    createMainForkCtx(stubFlag(true), [], createMockProvider(async (request, signal) => {
        if (requestTexts(request.content, 'user').some((text) => text.includes(STOPPED_CHILD_PROMPT))) {
          childRequests += 1;
          if (childRequests === 2) {
            return {
              request,
              result: {
                id: 'stopped-child',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: STOPPED_CHILD_DRAFT }],
                  toolCalls: [],
                },
                usage: null,
                finishReason: null,
                rawFinishReason: null,
              },
              parts: [{ type: 'text', text: STOPPED_CHILD_DRAFT }],
              error: waitForAbortReason(signal),
              onStream: childStreaming.resolve,
            };
          }
          return childScript.provider.respond(request, signal);
        }
        if (parentScript.calls.length === 1) {
          await childStreaming;
          const taskId = /task_id: (agent-[0-9a-z]+)/.exec(requestTexts(request.content).join('\n'))?.[1];
          parentScript.mockNextResponse({
            type: 'function',
            id: 'call_stop',
            name: 'TaskStop',
            arguments: JSON.stringify({ task_id: taskId }),
          });
        } else if (parentScript.calls.length === 2) {
          parentScript.mockNextResponse({ type: 'text', text: 'Stopped the subagent.' });
        }
        return parentScript.provider.respond(request, signal);
    }));
    const profile = ctx.get(IAgentLoopService);
    await ctx.get(IAgentLoopService).bindProfile({ profile: 'agent', model: 'mock-model' });
    profile.update({ activeToolNames: contributedToolNames() });
    ctx.get(IAgentPermissionModeService).setMode('yolo');
    parentScript.mockNextResponse({
      type: 'function',
      id: 'call_agent',
      name: 'Agent',
      arguments: JSON.stringify({
        description: 'trace parser loop',
        prompt: STOPPED_CHILD_PROMPT,
        run_in_background: true,
      }),
    });
    childScript.mockNextResponse(
      { type: 'text', text: STOPPED_CHILD_FINDING },
      {
        type: 'function',
        id: 'call_read',
        name: 'Read',
        arguments: JSON.stringify({ path: 'src/parser.ts' }),
      },
    );

    const loop = ctx.get(IAgentLoopService);
    const { id } = loop.submit({
      message: { role: 'user', content: [{ type: 'text', text: 'investigate the parser loop in the background' }] },
      meta: { origin: { kind: 'user' } },
    });
    expect((await loop.promptHandle(id)!.completion).state).toBe('completed');
    await loop.settled();

    expect(parentScript.calls).toHaveLength(3);
    expect(childRequests).toBe(2);
    const stopResult = parentScript.calls[2]!.history
      .filter((message) => message.role === 'tool' && message.toolCallId === 'call_stop')
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(stopResult).toContain('status: killed');
    expect(stopResult).not.toContain(STOPPED_CHILD_PROMPT);
    expect(JSON.stringify(parentScript.calls[2]!.history)).toContain('<notification id=');

    const tasks = ctx.get(IAgentTaskService);
    const [task] = tasks.list(false);
    expect(task).toMatchObject({ kind: 'agent', status: 'killed' });
    const output = await tasks.getOutputSnapshot(task!.taskId, 64 * 1024);
    expect(output.preview.indexOf(STOPPED_CHILD_FINDING)).toBeLessThan(
      output.preview.indexOf(STOPPED_CHILD_DRAFT),
    );
    expect(output.preview.split(STOPPED_CHILD_DRAFT)).toHaveLength(2);
  });

  it('records the text a foreground subagent wrote when the user interrupts the parent turn', async () => {
    const parentScript = createScriptedGenerate();
    const childStreaming = createControlledPromise<void>();
    let childRequests = 0;
    createMainForkCtx(stubFlag(true), [], createMockProvider(async (request, signal) => {
        if (requestTexts(request.content, 'user').some((text) => text.includes(STOPPED_CHILD_PROMPT))) {
          childRequests += 1;
          return {
            request,
            result: {
              id: 'stopped-child',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: STOPPED_CHILD_FINDING }],
                toolCalls: [],
              },
              usage: null,
              finishReason: null,
              rawFinishReason: null,
            },
            parts: [{ type: 'text', text: STOPPED_CHILD_FINDING }],
            error: waitForAbortReason(signal),
            onStream: () => {
              childStreaming.resolve();
              loop.cancel(undefined, userCancellationReason());
            },
          };
        }
        return parentScript.provider.respond(request, signal);
    }));
    const profile = ctx.get(IAgentLoopService);
    await ctx.get(IAgentLoopService).bindProfile({ profile: 'agent', model: 'mock-model' });
    profile.update({ activeToolNames: contributedToolNames() });
    ctx.get(IAgentPermissionModeService).setMode('yolo');
    parentScript.mockNextResponse({
      type: 'function',
      id: 'call_agent',
      name: 'Agent',
      arguments: JSON.stringify({ description: 'trace parser loop', prompt: STOPPED_CHILD_PROMPT }),
    });

    const loop = ctx.get(IAgentLoopService);
    const { id } = loop.submit({
      message: { role: 'user', content: [{ type: 'text', text: 'investigate the parser loop' }] },
      meta: { origin: { kind: 'user' } },
    });
    await childStreaming;
    expect((await loop.promptHandle(id)!.completion).state).toBe('cancelled');

    expect(parentScript.calls).toHaveLength(1);
    expect(childRequests).toBe(1);
    const agentResult = ctx
      .get(IAgentLoopService)
      .history()
      .filter((message) => message.role === 'tool' && message.toolCallId === 'call_agent')
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    expect(agentResult).toContain('stop_reason: cancelled');
    expect(agentResult).toContain('[partial output]');
    expect(agentResult).toContain(STOPPED_CHILD_FINDING);
  });
});
