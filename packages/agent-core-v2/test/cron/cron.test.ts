import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ConfigTarget, IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { SessionCronServiceImpl } from '#/session/cron/sessionCronServiceImpl';
import { parseCronExpression } from '#/app/cron/cron-expr';
import { isValidCronTask } from '#/app/cron/cronTaskPersistenceService';
import { ILogService } from '#/_base/log/log';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicDocumentStore, IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentTurnService, type Turn } from '#/agent/turn/turn';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubWireRecord } from '../contextMemory/stubs';
import { stubLog } from '../log/stubs';
import { stubTurn } from '../turn/stubs';

const FAR_FUTURE_MS = 10 * 366 * 24 * 60 * 60 * 1000;

function fakeTurn(): Turn {
  return {
    id: 1,
    signal: new AbortController().signal,
    ready: Promise.resolve(),
    result: Promise.resolve({ type: 'completed', steps: 0, truncated: false }),
  };
}

function textOf(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

// NOTE: the legacy `CronFireCoordinator` (which steered the main agent on fire
// through `IAgentTurnService.steer`) no longer exists in HEAD. Fire delivery now
// lives inside `SessionCronServiceImpl` itself: a due, idle task is delivered via
// `IAgentPromptService.steer`. The cases below cover that path directly, so there is
// no separate coordinator suite to migrate.

// TODO: The DI setup below was written for AgentCronService (Agent scope).
// SessionCronServiceImpl (Session scope) injects ISessionContext, ICronTaskPersistence,
// IAgentLifecycleService, ITelemetryService, IConfigService — not IAgentPromptService,
// IAgentRecordService, IAgentTurnService directly. The stub setup needs to be
// reworked to match the new dependency graph.
describe('SessionCronService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let now: number;
  let activeTurn: Turn | undefined;
  let steered: ContextMessage[];
  let steerLaunchError: Error | null;
  let storeRecords: Map<string, unknown>;

  beforeEach(() => {
    vi.stubEnv('KIMI_CRON_POLL_INTERVAL_MS', '0');
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    now = 0;
    activeTurn = undefined;
    steered = [];
    steerLaunchError = null;
    storeRecords = new Map();
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const turnService: IAgentTurnService = {
      ...stubTurn(),
      getActiveTurn: () => activeTurn,
    };

    ix.stub(IAgentPromptService, {
      prompt: () => Promise.resolve(undefined),
      steer: (message) => {
        steered.push(message);
        return {
          removeFromQueue: () => {},
          launched: steerLaunchError ? Promise.reject(steerLaunchError) : Promise.resolve(fakeTurn()),
        };
      },
      retry: () => undefined,
      undo: () => 0,
      clear: () => {},
    });
    ix.stub(IAgentWireRecordService, stubWireRecord());
    ix.stub(IAgentTurnService, turnService);
    ix.stub(ITelemetryService, { track: () => {} });
    ix.stub(IAgentToolRegistryService, { register: () => ({ dispose: () => {} }) });
    ix.stub(IBootstrapService, stubBootstrap());
    ix.stub(ISessionContext, {
      _serviceBrand: undefined,
      sessionId: 'test-session',
      workspaceId: 'test-workspace',
      sessionDir: '/tmp/kimi-cron-test/session',
      metaScope: 'session',
    });
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.stub(IAtomicDocumentStore, {
      async get<T>(_scope: string, key: string): Promise<T | undefined> {
        return storeRecords.get(key) as T | undefined;
      },
      async set(_scope: string, key: string, value: unknown): Promise<void> {
        storeRecords.set(key, value);
      },
      async delete(_scope: string, key: string): Promise<void> {
        storeRecords.delete(key);
      },
      async list(): Promise<readonly string[]> {
        return Array.from(storeRecords.keys());
      },
    });
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(
      ISessionCronService,
      new SyncDescriptor(SessionCronServiceImpl, [{}]),
    );
  });
  afterEach(() => {
    disposables.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('addTask / list / removeTasks', () => {
    const svc = ix.get(ISessionCronService);
    const task = svc.addTask({ cron: '* * * * *', prompt: 'hi', recurring: false });

    expect(svc.list()).toHaveLength(1);
    svc.removeTasks([task.id]);
    expect(svc.list()).toEqual([]);
  });

  it('does not fire while a turn is active', async () => {
    const svc = ix.get(ISessionCronService);
    svc.addTask({ cron: '* * * * *', prompt: 'fire-me', recurring: false });

    activeTurn = fakeTurn();
    now = FAR_FUTURE_MS;
    await svc.tick();

    expect(steered).toEqual([]);
  });

  it('fires a due task when idle', async () => {
    const svc = ix.get(ISessionCronService);
    svc.addTask({ cron: '* * * * *', prompt: 'fire-me', recurring: false });

    now = FAR_FUTURE_MS;
    await svc.tick();

    expect(steered).toHaveLength(1);
    expect(textOf(steered[0]!)).toContain('fire-me');
    expect(steered[0]!.origin).toMatchObject({ kind: 'cron_job' });
  });

  it('removes one-shot tasks after firing', async () => {
    const svc = ix.get(ISessionCronService);
    svc.addTask({ cron: '* * * * *', prompt: 'x', recurring: false });

    now = FAR_FUTURE_MS;
    await svc.tick();

    expect(svc.list()).toEqual([]);
  });

  it('isDisabled reflects live config (not frozen at registration)', async () => {
    const svc = ix.get(ISessionCronService);
    const config = ix.get(IConfigService);

    expect(svc.isDisabled()).toBe(false);
    await config.set('cron', { disabled: true }, ConfigTarget.Memory);
    expect(svc.isDisabled()).toBe(true);
    await config.set('cron', { disabled: false }, ConfigTarget.Memory);
    expect(svc.isDisabled()).toBe(false);
  });

  it('retains a one-shot and retries when steer launch rejects', async () => {
    const svc = ix.get(ISessionCronService);
    svc.addTask({ cron: '* * * * *', prompt: 'retry-me', recurring: false });

    steerLaunchError = new Error('turn not ready');
    now = FAR_FUTURE_MS;
    await svc.tick();

    // Launch was attempted but rejected: steer saw the prompt once, yet the
    // task survives for the next tick instead of being silently dropped.
    expect(steered).toHaveLength(1);
    expect(svc.list()).toHaveLength(1);

    steerLaunchError = null;
    await svc.tick();
    expect(steered).toHaveLength(2);
    expect(svc.list()).toEqual([]);
  });

  it('generates ULID ids and still accepts legacy 8-hex ids', () => {
    const svc = ix.get(ISessionCronService);
    const task = svc.addTask({ cron: '* * * * *', prompt: 'id', recurring: false });

    expect(task.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
    // Legacy 8-hex records (pre-ULID) remain valid for store reads.
    expect(
      isValidCronTask({ id: '3f1a9c2e', cron: '* * * * *', prompt: 'x', createdAt: 0 }),
    ).toBe(true);
    expect(
      isValidCronTask({ id: task.id, cron: '* * * * *', prompt: 'x', createdAt: 0 }),
    ).toBe(true);
  });

  it('computeDisplayNextFire honors live noJitter', async () => {
    const svc = ix.get(ISessionCronService);
    const config = ix.get(IConfigService);
    const task = svc.addTask({ cron: '0 9 * * *', prompt: 'p', recurring: true });
    const parsed = parseCronExpression(task.cron);
    const ideal = new Date(2024, 0, 2, 9, 0, 0, 0).getTime();

    await config.set('cron', { noJitter: true }, ConfigTarget.Memory);
    expect(svc.computeDisplayNextFire(task, parsed, ideal)).toBe(ideal);
  });

  it('adopts a valid but untagged legacy task and backfills the session tag', async () => {
    const svc = ix.get(ISessionCronService);
    storeRecords.set('3f1a9c2e.json', {
      id: '3f1a9c2e',
      cron: '* * * * *',
      prompt: 'legacy',
      createdAt: 0,
    });

    await svc.loadFromStore();

    const adopted = svc.getTask('3f1a9c2e');
    expect(adopted).toBeDefined();
    expect(adopted?.prompt).toBe('legacy');
    expect(adopted?.tags?.['sessionId']).toBe('test-session');
  });
});
