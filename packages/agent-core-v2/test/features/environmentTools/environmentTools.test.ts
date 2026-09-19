import { describe, expect, it } from 'vitest';

import type { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IConfigService } from '#/app/config/config';
import { ENVIRONMENTS_SECTION } from '#/environment/configSection';
import type { EnvironmentBinding } from '#/environment/environment';
import { EnvironmentRegistry, EnvironmentError } from '#/environment/environmentRegistry';
import type {
  EphemeralEnvironmentConnectRequest,
  IEphemeralEnvironmentConnector,
} from '#/environment/ephemeralEnvironment';
import { buildEnvironmentsInfo } from '#/features/environmentTools/environmentsInfo';
import {
  ENVIRONMENT_TOOLS_MAIN_AGENT_ONLY,
  ENVIRONMENT_TOOLS_PLAN_MODE_UNAVAILABLE,
} from '#/features/environmentTools/environmentTools';
import type { ChangeEnvironmentInput } from '#/features/environmentTools/tools/change-environment/changeEnvironment';
import { ChangeEnvironmentTool } from '#/features/environmentTools/tools/change-environment/changeEnvironmentTool';
import type { ConnectEnvironmentInput } from '#/features/environmentTools/tools/connect/connect';
import { ConnectEnvironmentTool } from '#/features/environmentTools/tools/connect/connectTool';
import type { IAgentPlanService, PlanData } from '#/features/plan/plan';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { compileToolArgsValidator, validateToolArgs } from '#/tool/args-validator';
import type { RunnableToolExecution } from '#/tool/toolContract';
import type { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { fakeEnvironment } from '../../environment/stubs';

const mainScope = makeAgentScopeContext({ agentId: 'main', agentScope: '' });
const subagentScope = makeAgentScopeContext({ agentId: 'agent-1', agentScope: '' });

function session() {
  return makeSessionContext({
    sessionId: 'session',
    workspaceId: 'workspace',
    sessionDir: '/session',
    sessionScope: 'sessions/session',
    cwd: '/workspace',
  });
}

function planMode(plan: PlanData = null): IAgentPlanService {
  return {
    _serviceBrand: undefined,
    status: async () => plan,
  } as unknown as IAgentPlanService;
}

function bindingStub(
  calls: { environmentId: string; cwd?: string }[],
  current: EnvironmentBinding = { workspaceId: 'workspace', environmentId: 'local' },
): IAgentEnvironmentBindingService {
  return {
    _serviceBrand: undefined,
    get current() {
      return current;
    },
    connectAndSwitchAtTurnBoundary: async (environmentId: string, cwd?: string) => {
      calls.push({ environmentId, cwd });
      return { workspaceId: 'workspace', environmentId, cwd };
    },
  } as unknown as IAgentEnvironmentBindingService;
}

function workspacesStub(registry: EnvironmentRegistry, root = '/repo'): IWorkspaceInstanceManager {
  return {
    _serviceBrand: undefined,
    get: (workspaceId: string) =>
      workspaceId === 'workspace' ? ({ environments: registry, root } as never) : undefined,
  } as unknown as IWorkspaceInstanceManager;
}

function configStub(section: unknown): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (domain: string) => (domain === ENVIRONMENTS_SECTION ? section : undefined),
  } as unknown as IConfigService;
}

function docsStub(): IAtomicDocumentStore {
  return {
    _serviceBrand: undefined,
    get: async () => undefined,
  } as unknown as IAtomicDocumentStore;
}

describe('buildEnvironmentsInfo', () => {
  it('lists each environment with its status and marks the current one', () => {
    const registry = new EnvironmentRegistry('workspace');
    registry.register(fakeEnvironment('local', 'local-one', { status: 'ready' }));
    registry.register(fakeEnvironment('dev-box', 'dev-box-one', { status: 'disconnected' }));

    expect(buildEnvironmentsInfo(registry.snapshot(), 'local')).toBe(
      '- `local` (ready, current)\n- `dev-box` (disconnected)',
    );
  });
});

describe('ChangeEnvironmentTool', () => {
  function createTool(
    options: {
      readonly scope?: typeof mainScope;
      readonly plan?: PlanData;
      readonly config?: unknown;
      readonly registry?: EnvironmentRegistry;
    } = {},
  ) {
    const calls: { environmentId: string; cwd?: string }[] = [];
    const registry = options.registry ?? new EnvironmentRegistry('workspace');
    const tool = new ChangeEnvironmentTool(
      options.scope ?? mainScope,
      bindingStub(calls),
      planMode(options.plan),
      session(),
      workspacesStub(registry),
      configStub(options.config),
      {} as IHostFileSystem,
      docsStub(),
    );
    return { tool, calls };
  }

  it('rejects subagents', async () => {
    const { tool, calls } = createTool({ scope: subagentScope });
    const result = await tool.resolveExecution({ id: 'local' } as ChangeEnvironmentInput);
    expect(result).toEqual({ isError: true, output: ENVIRONMENT_TOOLS_MAIN_AGENT_ONLY });
    expect(calls).toHaveLength(0);
  });

  it('rejects in plan mode', async () => {
    const { tool, calls } = createTool({ plan: { id: 'p1', content: 'plan', path: '/plan.md' } });
    const result = await tool.resolveExecution({ id: 'local' } as ChangeEnvironmentInput);
    expect(result).toEqual({ isError: true, output: ENVIRONMENT_TOOLS_PLAN_MODE_UNAVAILABLE });
    expect(calls).toHaveLength(0);
  });

  it('switches to local without a cwd and reports the scheduled switch', async () => {
    const { tool, calls } = createTool();
    const execution = await tool.resolveExecution({ id: 'local' } as ChangeEnvironmentInput);
    expect(execution).toMatchObject({ approvalRule: 'change_environment' });

    const result = await (execution as RunnableToolExecution).execute({} as never);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('"local"');
    expect(result.output).toContain('scheduled');
    expect(calls).toEqual([{ environmentId: 'local', cwd: undefined }]);
  });

  it('falls back to the declaration defaultCwd when cwd is omitted', async () => {
    const { tool, calls } = createTool({
      config: { 'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me/projects' } },
    });
    const execution = await tool.resolveExecution({ id: 'dev-box' } as ChangeEnvironmentInput);
    await (execution as RunnableToolExecution).execute({} as never);
    expect(calls).toEqual([{ environmentId: 'dev-box', cwd: '/home/me/projects' }]);
  });

  it('prefers the explicit cwd over the declaration defaultCwd', async () => {
    const { tool, calls } = createTool({
      config: { 'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me/projects' } },
    });
    const execution = await tool.resolveExecution({
      id: 'dev-box',
      cwd: '/srv/app',
    } as ChangeEnvironmentInput);
    await (execution as RunnableToolExecution).execute({} as never);
    expect(calls).toEqual([{ environmentId: 'dev-box', cwd: '/srv/app' }]);
  });

  it('requires a cwd for remote environments without a declaration defaultCwd', async () => {
    const { tool, calls } = createTool({ config: { 'dev-box': { type: 'ssh', host: 'dev-box' } } });
    const result = await tool.resolveExecution({ id: 'dev-box' } as ChangeEnvironmentInput);
    expect(result).toMatchObject({ isError: true });
    expect((result as { output: string }).output).toContain('defaultCwd');
    expect(calls).toHaveLength(0);
  });

  it('maps binding EnvironmentError rejections to tool errors', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const tool = new ChangeEnvironmentTool(
      mainScope,
      {
        _serviceBrand: undefined,
        get current() {
          return { workspaceId: 'workspace', environmentId: 'local' };
        },
        connectAndSwitchAtTurnBoundary: async () => {
          throw new EnvironmentError(
            'environment.not_found',
            'environment "ghost" does not exist in workspace workspace',
          );
        },
      } as unknown as IAgentEnvironmentBindingService,
      planMode(),
      session(),
      workspacesStub(registry),
      configStub(undefined),
      {} as IHostFileSystem,
      docsStub(),
    );
    const execution = await tool.resolveExecution({
      id: 'ghost',
      cwd: '/x',
    } as ChangeEnvironmentInput);
    const result = await (execution as RunnableToolExecution).execute({} as never);
    expect(result).toEqual({
      isError: true,
      output: 'environment "ghost" does not exist in workspace workspace',
    });
  });
});

describe('ConnectEnvironmentTool', () => {
  function createTool(
    options: {
      readonly scope?: typeof mainScope;
      readonly plan?: PlanData;
      readonly registry?: EnvironmentRegistry;
      readonly connector?: IEphemeralEnvironmentConnector;
    } = {},
  ) {
    const registry = options.registry ?? new EnvironmentRegistry('workspace');
    const tool = new ConnectEnvironmentTool(
      options.scope ?? mainScope,
      planMode(options.plan),
      session(),
      workspacesStub(registry),
      options.connector ?? unavailableConnector(),
    );
    return { tool, registry };
  }

  function unavailableConnector(): IEphemeralEnvironmentConnector {
    return {
      _serviceBrand: undefined,
      connect: async () => {
        throw new EnvironmentError(
          'environment.unavailable',
          'temporary environments are not available in this process (the remote-exec client is not loaded)',
        );
      },
    } as unknown as IEphemeralEnvironmentConnector;
  }

  it('exposes parameters as a strict-provider-compatible object schema', () => {
    const { tool } = createTool();

    expect(tool.parameters['type']).toBe('object');

    const validator = compileToolArgsValidator(tool.parameters);
    expect(validateToolArgs(validator, { type: 'ssh', host: 'dev-box' })).toBeNull();
    expect(validateToolArgs(validator, { type: 'docker', container: 'web' })).toBeNull();
    expect(validateToolArgs(validator, { type: 'command', command: 'kimi-exec' })).toBeNull();
    expect(validateToolArgs(validator, { type: 'ssh' })).not.toBeNull();
    expect(
      validateToolArgs(validator, { type: 'ssh', host: 'dev-box', bogus: true }),
    ).not.toBeNull();
  });

  it('rejects subagents', async () => {
    const { tool } = createTool({ scope: subagentScope });
    const result = await tool.resolveExecution({
      type: 'ssh',
      host: 'dev-box',
    } as ConnectEnvironmentInput);
    expect(result).toEqual({ isError: true, output: ENVIRONMENT_TOOLS_MAIN_AGENT_ONLY });
  });

  it('rejects in plan mode', async () => {
    const { tool } = createTool({ plan: { id: 'p1', content: 'plan', path: '/plan.md' } });
    const result = await tool.resolveExecution({
      type: 'ssh',
      host: 'dev-box',
    } as ConnectEnvironmentInput);
    expect(result).toEqual({ isError: true, output: ENVIRONMENT_TOOLS_PLAN_MODE_UNAVAILABLE });
  });

  it('rejects reserved and already-registered ids', async () => {
    const registry = new EnvironmentRegistry('workspace');
    registry.register(fakeEnvironment('taken', 'taken-one'));
    const { tool } = createTool({ registry });

    const reserved = await tool.resolveExecution({
      type: 'ssh',
      host: 'dev-box',
      id: 'local',
    } as ConnectEnvironmentInput);
    expect(reserved).toMatchObject({ isError: true });
    expect((reserved as { output: string }).output).toContain('reserved');

    const taken = await tool.resolveExecution({
      type: 'ssh',
      host: 'dev-box',
      id: 'taken',
    } as ConnectEnvironmentInput);
    expect(taken).toMatchObject({ isError: true });
    expect((taken as { output: string }).output).toContain('already exists');
  });

  it('registers the connected environment and reports host details and hints', async () => {
    const requests: EphemeralEnvironmentConnectRequest[] = [];
    const connected = fakeEnvironment('dev-box-a1b2c3', 'gen-one', {
      status: 'ready',
      host: {
        osKind: 'Linux',
        osArch: 'x86_64',
        osVersion: '6.1',
        shellName: 'bash',
        shellPath: '/bin/bash',
      },
    });
    const connector = {
      _serviceBrand: undefined,
      connect: async (request: EphemeralEnvironmentConnectRequest) => {
        requests.push(request);
        request.registry.register(connected);
        return { environment: connected, initialCwd: '/home/me' };
      },
    } as unknown as IEphemeralEnvironmentConnector;
    const { tool, registry } = createTool({ connector });

    const execution = await tool.resolveExecution({
      type: 'ssh',
      host: 'dev-box',
      id: 'dev-box-a1b2c3',
    } as ConnectEnvironmentInput);
    expect(execution).toMatchObject({ approvalRule: 'connect' });
    const result = await (execution as RunnableToolExecution).execute({} as never);

    expect(result.isError).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      workspaceId: 'workspace',
      environmentId: 'dev-box-a1b2c3',
      entry: { type: 'ssh', host: 'dev-box', remoteBin: undefined },
    });
    expect(registry.current('dev-box-a1b2c3')).toBe(connected);
    expect(result.output).toContain('"dev-box-a1b2c3"');
    expect(result.output).toContain('Linux 6.1 x86_64');
    expect(result.output).toContain('change_environment');
    expect(result.output).toContain('/home/me');
  });

  it('generates an id from the launcher when omitted', async () => {
    const requests: EphemeralEnvironmentConnectRequest[] = [];
    const connector = {
      _serviceBrand: undefined,
      connect: async (request: EphemeralEnvironmentConnectRequest) => {
        requests.push(request);
        const environment = fakeEnvironment(request.environmentId, 'gen-one');
        request.registry.register(environment);
        return { environment, initialCwd: '/home/me' };
      },
    } as unknown as IEphemeralEnvironmentConnector;
    const { tool } = createTool({ connector });

    const execution = await tool.resolveExecution({
      type: 'docker',
      container: 'myapp-dev',
    } as ConnectEnvironmentInput);
    const result = await (execution as RunnableToolExecution).execute({} as never);

    expect(result.isError).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.environmentId).toMatch(/^myapp-dev-[0-9a-f]{6}$/);
  });

  it('surfaces the connector failure and leaves nothing registered', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const connector = {
      _serviceBrand: undefined,
      connect: async () => {
        throw new EnvironmentError(
          'environment.unavailable',
          'failed to connect environment dev-box: handshake timeout',
        );
      },
    } as unknown as IEphemeralEnvironmentConnector;
    const { tool } = createTool({ registry, connector });

    const execution = await tool.resolveExecution({
      type: 'ssh',
      host: 'dev-box',
      id: 'dev-box-x',
    } as ConnectEnvironmentInput);
    const result = await (execution as RunnableToolExecution).execute({} as never);

    expect(result).toEqual({
      isError: true,
      output: 'failed to connect environment dev-box: handshake timeout',
    });
    expect(registry.list()).toHaveLength(0);
  });

  it('reports the unavailable connector cleanly', async () => {
    const { tool } = createTool();
    const execution = await tool.resolveExecution({
      type: 'command',
      command: 'sandbox',
    } as ConnectEnvironmentInput);
    const result = await (execution as RunnableToolExecution).execute({} as never);
    expect(result).toMatchObject({ isError: true });
    expect((result as { output: string }).output).toContain('not available in this process');
  });
});
