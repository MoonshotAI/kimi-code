import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  IAgentFullCompactionService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentToolExecutorService,
  IAgentToolRegistryService,
  IEventBus,
  ISessionManager,
  SubagentSpawned,
  type ExecutableTool,
} from '@moonshot-ai/agent-core-v2';
import { TurnEnded } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { ISessionEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import { IMAGE_BYTE_BUDGET, resolveMaxImageEdgePx, startServer } from '../src/index';
import type { HostAgent, HostExtension } from '../src/index';

const homes: string[] = [];
const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it('exposes session and agent capabilities without leaking engine scopes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kap-host-extension-'));
  homes.push(home);
  const createdAgents: HostAgent[] = [];
  const closedAgents: string[] = [];
  const createdSessions: string[] = [];
  const closedSessions: string[] = [];
  const deletedSessions: string[] = [];
  const spawnedAgents: string[] = [];
  const extension: HostExtension = {
    onWillCreateSession: (event) => {
      event.contributeMcpServer('host_test', {
        transport: 'http',
        url: 'http://127.0.0.1:1/mcp',
        deferred: true,
      });
    },
    onDidCreateSession: (session) => createdSessions.push(session.id),
    onDidCloseSession: (sessionId) => closedSessions.push(sessionId),
    onWillDeleteSession: (sessionId) => deletedSessions.push(sessionId),
    onDidCreateAgent: (agent) => createdAgents.push(agent),
    onDidCloseAgent: (event) => closedAgents.push(`${event.sessionId}:${event.agentId}:${event.generation}`),
    onDidSpawnSubagent: (event) => spawnedAgents.push(`${event.sessionId}:${event.agentId}:${event.description}`),
  };
  const server = await startServer({
    hostIdentity: { productName: 'test-host', platform: 'test', version: '0.0.0' },
    homeDir: home,
    port: 0,
    logLevel: 'silent',
    env: { ...process.env, KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL: 'false', KIMI_CODE_EXPERIMENTAL_SEARCH_WORKER: 'false' },
    hostExtension: extension,
  });
  servers.push(server);
  const manager = server.core.accessor.get(ISessionManager);
  const handle = await manager.create({ workDir: home });
  const hostSession = server.sessions.get(handle.id)!;
  expect(createdSessions).toEqual([handle.id]);
  expect(hostSession.mcpServer('host_test')).toBeDefined();

  const lifecycle = handle.accessor.get(IAgentLifecycleService);
  const mainContext = await lifecycle.create({ agentId: 'main' });
  const main = lifecycle.handleOf('main')!;
  vi.spyOn(main.accessor.get(IAgentFullCompactionService) as unknown as { beforeStep(): Promise<void> }, 'beforeStep').mockResolvedValue();
  const hostAgent = createdAgents.find((agent) => agent.id === 'main')!;
  expect(hostAgent.generation).toBe(mainContext.generation);
  expect(hostAgent.meta?.type).toBe('main');
  expect(hostAgent.state()).toMatchObject({ running: false });
  expect(await hostSession.agents()).toHaveProperty('main');

  hostAgent.registerReminder('host-test', (context) => context.isNewTurn ? { content: 'host reminder', disclosure: { seen: true } } : undefined);
  const loop = main.accessor.get(IAgentLoopService);
  await loop.hooks.onWillBeginStep.run({ turnId: 1, step: 1, firstStepOfTurn: true, signal: new AbortController().signal });
  loop.flushReminders();
  expect(JSON.stringify(await hostSession.readAgentHistory('main'))).toContain('host reminder');

  const tool: ExecutableTool = {
    name: 'HostEcho',
    description: 'host echo',
    parameters: { type: 'object' },
    resolveExecution: (args) => ({
      approvalRule: 'always-allow',
      execute: async () => ({ output: JSON.stringify(args) }),
    }),
  } as ExecutableTool;
  main.accessor.get(IAgentToolRegistryService).register(tool, { source: 'builtin' });
  main.accessor.get(IAgentPermissionModeService).setMode('yolo');
  hostAgent.decorateToolArguments('HostEcho', (args, context) => ({
    ...(args as Record<string, unknown>),
    injectedTurn: context.turnId,
  }));
  hostAgent.onDidExecuteTool((context) => context.toolName === 'HostEcho' ? { output: 'host tool intercepted' } : undefined);
  const executor = main.accessor.get(IAgentToolExecutorService);
  const call = { type: 'function' as const, id: 'host-call', name: 'HostEcho', arguments: '{}' };
  const result = await executor.executor.execute(call, { turnId: 7 });
  expect(result.content).toEqual([{ type: 'text', text: 'host tool intercepted' }]);

  const ended = vi.fn();
  hostAgent.onDidTurnEnd(ended);
  main.accessor.get(IEventBus).publish(new TurnEnded({ agentId: 'main', turnId: 7, reason: 'completed' }), mainContext);
  expect(ended).toHaveBeenCalledWith(expect.objectContaining({ turnId: 7 }));

  const workerContext = await lifecycle.create({ agentId: 'worker' });
  handle.accessor.get(ISessionEventBus).publish(new SubagentSpawned({
    subagentId: 'worker', subagentName: 'coder', parentToolCallId: 'parent-call', description: 'Inspect docs', runInBackground: true,
  }));
  expect(spawnedAgents).toEqual([`${handle.id}:worker:Inspect docs`]);
  await lifecycle.remove(workerContext);
  expect(closedAgents).toContain(`${handle.id}:worker:${workerContext.generation}`);
  await manager.close(handle.id);
  expect(closedSessions).toEqual([handle.id]);
  await manager.delete(handle.id);
  expect(deletedSessions).toEqual([handle.id]);
}, 30000);


it('exposes host telemetry and public image limits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kap-host-telemetry-'));
  homes.push(home);
  const server = await startServer({
    hostIdentity: { productName: 'test-host', platform: 'test', version: '0.0.0' },
    homeDir: home,
    port: 0,
    logLevel: 'silent',
    env: { ...process.env, KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL: 'false', KIMI_CODE_EXPERIMENTAL_SEARCH_WORKER: 'false' },
  });
  servers.push(server);
  await expect(server.hostTelemetry.readConsent()).resolves.toBeUndefined();
  await expect(server.hostTelemetry.getCachedAccessToken()).resolves.toBeNull();
  await expect(server.hostTelemetry.countSessions()).resolves.toBe(0);
  const appender = server.hostTelemetry.createCloudAppender({
    deviceId: 'device-test',
    appName: 'test-host',
    getAccessToken: () => null,
  });
  expect(appender).toEqual(expect.objectContaining({
    track: expect.any(Function),
    startPeriodicFlush: expect.any(Function),
    stopPeriodicFlush: expect.any(Function),
    retryDiskEvents: expect.any(Function),
  }));
  await server.core.accessor.get(ISessionManager).create({ workDir: home });
  await expect(server.hostTelemetry.countSessions()).resolves.toBe(1);
  expect(IMAGE_BYTE_BUDGET).toBeGreaterThan(0);
  expect(resolveMaxImageEdgePx()).toBeGreaterThan(0);
}, 30000);
