import { describe, expect, it } from 'vitest';

import type { IAgentTaskService } from '#/agent/task/task';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type { IConfigService } from '#/app/config/config';
import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type { Environment } from '#/environment/environment';
import { makeSessionContext, type ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ToolExecution } from '#/tool/toolContract';
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
