import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { IAgentTaskService } from '#/agent/task/task';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type { IConfigService } from '#/app/config/config';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type { Environment } from '#/environment/environment';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { makeSessionContext, type ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ToolExecution, ExecutableToolOutput } from '#/tool/toolContract';
import { BashTool } from '#/agent/tools/os/bash/bashTool';
import type { BashInput } from '#/agent/tools/os/bash/bash';

import { stubWorkspaceContext } from '../../../../session/workspaceContext/stub-workspace-context';
import { stubAgentEnvironment } from '../../../../environment/stubs';

function testCtx(cwd: string): ISessionContext {
  return makeSessionContext({
    sessionId: 's',
    workspaceId: 'w',
    sessionDir: cwd,
    sessionScope: 'sessions/w/s',
    cwd,
  });
}

function environmentService(environment: Environment): IAgentEnvironmentService {
  return stubAgentEnvironment(environment, { workDir: '' });
}

function throwingEnvironmentService(): IAgentEnvironmentService {
  return {
    ...stubAgentEnvironment(new FakeEnvironment({ workspaceId: 'w', environmentId: 'local', generation: 'g' }), { workDir: '' }),
    inspect: () => {
      throw new Error('environment w is not materialized');
    },
  };
}

function bashTool(environment: IAgentEnvironmentService, ctx: ISessionContext, workDir: string): BashTool {
  return new BashTool(
    environment,
    ctx,
    stubWorkspaceContext(workDir),
    {} as unknown as IAgentTaskService,
    {} as unknown as IAgentToolPolicyService,
    {} as unknown as IConfigService,
  );
}

async function displayCwd(tool: BashTool, args: BashInput): Promise<string | undefined> {
  const resolved: ToolExecution = await Promise.resolve(tool.resolveExecution(args));
  if (resolved.isError === true) return undefined;
  const display = resolved.display;
  return display?.kind === 'command' ? display.cwd : undefined;
}

describe('BashTool display cwd', () => {
  it('stamps the binding cwd resolved on the bound environment when no cwd argument is given', async () => {
    const environment = new FakeEnvironment({ workspaceId: 'w', environmentId: 'dev-box', generation: 'g' });
    const tool = bashTool(environmentService(environment), testCtx('/Users/mac/project'), '/home/deploy/app');

    await expect(displayCwd(tool, { command: 'ls' })).resolves.toBe('/home/deploy/app');
  });

  it('resolves a relative cwd argument against the binding cwd on the bound environment', async () => {
    const environment = new FakeEnvironment({ workspaceId: 'w', environmentId: 'dev-box', generation: 'g' });
    const tool = bashTool(environmentService(environment), testCtx('/Users/mac/project'), '/home/deploy/app');

    await expect(displayCwd(tool, { command: 'ls', cwd: 'src/lib' })).resolves.toBe(
      '/home/deploy/app/src/lib',
    );
  });

  it('keeps an absolute cwd argument as resolved on the bound environment', async () => {
    const environment = new FakeEnvironment({ workspaceId: 'w', environmentId: 'dev-box', generation: 'g' });
    const tool = bashTool(environmentService(environment), testCtx('/Users/mac/project'), '/home/deploy/app');

    await expect(displayCwd(tool, { command: 'ls', cwd: '/var/log' })).resolves.toBe('/var/log');
  });

  it('stamps the resolved local workspace dir for a local environment', async () => {
    const environment = new FakeEnvironment({ workspaceId: 'w', environmentId: 'local', generation: 'g' });
    const tool = bashTool(environmentService(environment), testCtx('/workspace'), '/workspace');

    await expect(displayCwd(tool, { command: 'ls' })).resolves.toBe('/workspace');
    await expect(displayCwd(tool, { command: 'ls', cwd: 'src' })).resolves.toBe('/workspace/src');
  });

  it('falls back to the raw argument or session cwd when the environment cannot be inspected', async () => {
    const tool = bashTool(throwingEnvironmentService(), testCtx('/workspace'), '/workspace');

    await expect(displayCwd(tool, { command: 'ls' })).resolves.toBe('/workspace');
    await expect(displayCwd(tool, { command: 'ls', cwd: 'src' })).resolves.toBe('src');
  });
});

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { readonly cwd?: string; readonly env?: Record<string, string> };
}

function fakeProcess(records: SpawnRecord[]): IHostProcessService {
  return {
    _serviceBrand: undefined,
    spawn: async (command: string, args: readonly string[] = [], options: { cwd?: string; env?: Record<string, string> } = {}) => {
      records.push({ command, args, options });
      const stdout = new Readable({ read() { stdout.push(null); } });
      const stderr = new Readable({ read() { stderr.push(null); } });
      const proc: IHostProcess = {
        _serviceBrand: undefined,
        pid: 123,
        exitCode: 0,
        stdin: new Writable({ write: (_chunk, _encoding, callback) => { callback(); } }),
        stdout,
        stderr,
        wait: async () => 0,
        kill: async () => {},
        dispose: () => {},
      };
      return proc;
    },
  } as IHostProcessService;
}

function stubTasks(): IAgentTaskService {
  return {
    registerTask: () => 'bash-1',
    waitForForegroundRelease: async () => 'completed',
    getTask: () => undefined,
  } as unknown as IAgentTaskService;
}

function errorText(output: ExecutableToolOutput): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

async function runCommand(tool: BashTool, args: BashInput): Promise<void> {
  const resolved: ToolExecution = await Promise.resolve(tool.resolveExecution(args));
  if (resolved.isError === true) throw new Error(errorText(resolved.output));
  const result = await resolved.execute({ turnId: 0, toolCallId: 'call_1', signal: new AbortController().signal });
  if (result.isError === true) throw new Error(errorText(result.output));
}

describe('BashTool spawn cwd', () => {
  it('passes the session workDir as an explicit spawn cwd', async () => {
    const records: SpawnRecord[] = [];
    const environment = Object.assign(
      new FakeEnvironment({ workspaceId: 'w', environmentId: 'dev-box', generation: 'g' }),
      { process: fakeProcess(records) },
    );
    const tool = new BashTool(
      stubAgentEnvironment(environment),
      testCtx('/Users/mac/project'),
      stubWorkspaceContext('/home/deploy/app'),
      stubTasks(),
      { isToolActive: () => false } as unknown as IAgentToolPolicyService,
      { get: () => undefined } as unknown as IConfigService,
    );

    await runCommand(tool, { command: 'ls' });

    expect(records).toHaveLength(1);
    expect(records[0]!.command).toBe('/bin/sh');
    expect(records[0]!.args[1]).toBe("cd '/home/deploy/app' && ls");
    expect(records[0]!.options.cwd).toBe('/home/deploy/app');
    expect(records[0]!.options.env).toMatchObject({ NO_COLOR: '1', TERM: 'dumb' });
  });

  it('spawns each session command with its own workDir on a shared environment', async () => {
    const records: SpawnRecord[] = [];
    const environment = Object.assign(
      new FakeEnvironment({ workspaceId: 'w', environmentId: 'dev-box', generation: 'g' }),
      { process: fakeProcess(records) },
    );
    const makeTool = (workDir: string) => new BashTool(
      stubAgentEnvironment(environment),
      testCtx('/Users/mac/project'),
      stubWorkspaceContext(workDir),
      stubTasks(),
      { isToolActive: () => false } as unknown as IAgentToolPolicyService,
      { get: () => undefined } as unknown as IConfigService,
    );

    await runCommand(makeTool('/remote/a'), { command: 'ls' });
    await runCommand(makeTool('/remote/b'), { command: 'ls', cwd: 'src' });

    expect(records.map((record) => record.options.cwd)).toEqual(['/remote/a', '/remote/b/src']);
  });
});
