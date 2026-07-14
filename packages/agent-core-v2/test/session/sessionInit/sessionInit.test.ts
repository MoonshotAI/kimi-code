import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { UserCancellationError } from '#/_base/utils/abort';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem, type HostFileStat } from '#/os/interface/hostFileSystem';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionInitService } from '#/session/sessionInit/sessionInit';
import { SessionInitService } from '#/session/sessionInit/sessionInitService';

const WORK_DIR = '/project';
const AGENTS_MD = 'latest project instructions';
const AGENTS_MD_PATH = `${WORK_DIR}/AGENTS.md`;
const GIT_DIR_PATH = `${WORK_DIR}/.git`;

describe('SessionInitService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let events: unknown[];
  let appendSystemReminder: ReturnType<typeof vi.fn>;
  let flush: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let run: ReturnType<typeof vi.fn>;
  let runCompletion: Promise<{ summary: string; usage?: undefined }>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    events = [];
    appendSystemReminder = vi.fn();
    flush = vi.fn(async () => {});
    runCompletion = Promise.resolve({ summary: 'Explored and wrote AGENTS.md', usage: undefined });

    const handles: Record<string, { id: string; accessor: { get: (id: unknown) => unknown } }> = {};
    const lifecycle = {
      _serviceBrand: undefined,
      hooks: {
        onWillStartAgentTask: { run: vi.fn(async () => {}) },
      },
      notifyAgentTaskStopped: vi.fn(),
      getHandle: vi.fn((id: string) => handles[id]),
      create: vi.fn(async () => handles['agent-0']),
      run: vi.fn(async (agentId: string) => ({
        agentId,
        turn: {},
        completion: runCompletion,
      })),
    };
    create = lifecycle.create;
    run = lifecycle.run;

    const eventBus = { publish: vi.fn((event: unknown) => events.push(event)) };
    const telemetry = { track: vi.fn(), track2: vi.fn() };
    const profile = {
      data: () => ({ modelAlias: 'mock-model', thinkingLevel: 'off', cwd: WORK_DIR }),
    };
    const permissionMode = { mode: 'auto' };

    handles['main'] = {
      id: 'main',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentLifecycleService) return lifecycle;
          if (id === IAgentProfileService) return profile;
          if (id === IAgentPermissionModeService) return permissionMode;
          if (id === IAgentSystemReminderService) return { appendSystemReminder };
          if (id === IAgentWireRecordService) return { flush };
          if (id === IEventBus) return eventBus;
          if (id === ITelemetryService) return telemetry;
          return undefined;
        },
      },
    };
    handles['agent-0'] = {
      id: 'agent-0',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentContextSizeService) return undefined;
          return undefined;
        },
      },
    };

    ix.stub(IAgentLifecycleService, lifecycle as unknown as IAgentLifecycleService);
    ix.stub(IHostFileSystem, {
      _serviceBrand: undefined,
      stat: vi.fn(async (path: string): Promise<HostFileStat> => {
        if (path === GIT_DIR_PATH) return { isFile: false, isDirectory: true, size: 0 };
        if (path === AGENTS_MD_PATH)
          return { isFile: true, isDirectory: false, size: AGENTS_MD.length };
        throw new Error(`ENOENT: ${path}`);
      }),
      readText: vi.fn(async (path: string) => {
        if (path === AGENTS_MD_PATH) return AGENTS_MD;
        throw new Error(`ENOENT: ${path}`);
      }),
    } as unknown as IHostFileSystem);
    ix.stub(IHostEnvironment, {
      _serviceBrand: undefined,
      homeDir: '/home',
    } as unknown as IHostEnvironment);
    ix.stub(IBootstrapService, {
      _serviceBrand: undefined,
      homeDir: '/home/brand',
    } as unknown as IBootstrapService);
    ix.set(ISessionInitService, new SyncDescriptor(SessionInitService));
  });

  afterEach(() => disposables.dispose());

  it('spawns a coder subagent, reloads AGENTS.md, and reminds the main agent', async () => {
    const svc = ix.get(ISessionInitService);
    await svc.generateAgentsMd();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      binding: { profile: 'coder', model: 'mock-model', thinking: 'off', cwd: WORK_DIR },
      permissionMode: 'auto',
    });

    expect(run).toHaveBeenCalledTimes(1);
    const runArgs = run.mock.calls[0]!;
    expect(runArgs[0]).toBe('agent-0');
    expect(runArgs[1]).toMatchObject({ kind: 'prompt' });
    expect((runArgs[1] as { prompt: string }).prompt).toContain('Task requirements:');

    expect(appendSystemReminder).toHaveBeenCalledTimes(1);
    const [reminder, origin] = appendSystemReminder.mock.calls[0] as [string, unknown];
    expect(origin).toEqual({ kind: 'injection', variant: 'init' });
    expect(reminder).toContain('The user just ran `/init` slash command.');
    expect(reminder).toContain('Latest AGENTS.md file content:');
    expect(reminder).toContain(AGENTS_MD);

    expect(flush).toHaveBeenCalledTimes(1);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent.spawned',
        subagentId: 'agent-0',
        subagentName: 'coder',
        parentToolCallId: 'generate-agents-md',
        callerAgentId: 'main',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'subagent.completed', subagentId: 'agent-0' }),
    );
  });

  it('wraps a subagent failure in SESSION_INIT_FAILED', async () => {
    run.mockImplementationOnce((agentId: string) => ({
      agentId,
      turn: {},
      completion: Promise.reject(new Error('coder exploded')),
    }));
    const svc = ix.get(ISessionInitService);

    const error = await svc.generateAgentsMd().catch((e) => e);
    expect(error).toBeInstanceOf(Error2);
    expect((error as Error2).code).toBe(ErrorCodes.SESSION_INIT_FAILED);
    expect((error as Error2).message).toContain('coder exploded');
  });

  it('throws AGENT_NOT_FOUND when the main agent is missing', async () => {
    const lifecycle = ix.get(IAgentLifecycleService) as unknown as {
      getHandle: ReturnType<typeof vi.fn>;
    };
    lifecycle.getHandle.mockReturnValue(undefined);
    const svc = ix.get(ISessionInitService);

    const error = await svc.generateAgentsMd().catch((e) => e);
    expect(error).toBeInstanceOf(Error2);
    expect((error as Error2).code).toBe(ErrorCodes.AGENT_NOT_FOUND);
  });

  it('cancelInit aborts the in-flight run without wrapping the cancellation', async () => {
    run.mockImplementationOnce((agentId: string, _req: unknown, opts: { signal: AbortSignal }) => ({
      agentId,
      turn: {},
      // The real lifecycle rejects the run completion when the launch signal
      // aborts; mirror that so the service-level propagation is exercised.
      completion: new Promise<{ summary: string }>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
      }),
    }));
    const svc = ix.get(ISessionInitService);

    const pending = svc.generateAgentsMd();
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    svc.cancelInit();

    const error = await pending.catch((e) => e);
    // Surfaces as a user cancellation (TUI resets quietly on isAbortError),
    // never as SESSION_INIT_FAILED, and without a subagent.failed event.
    expect(error).toBeInstanceOf(UserCancellationError);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'subagent.failed', subagentId: 'agent-0' }),
    );
  });

  it('cancelInit is a no-op when no init run is in flight', () => {
    const svc = ix.get(ISessionInitService);
    expect(() => svc.cancelInit()).not.toThrow();
  });
});
