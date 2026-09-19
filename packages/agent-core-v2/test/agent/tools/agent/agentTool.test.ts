import { describe, expect, it } from 'vitest';

import type { CollectionView } from '#/_base/di/collection';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { IAgentTaskService } from '#/agent/task/task';
import type { IAgentProfileService } from '#/agent/profile/profile';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import type { ILogService } from '#/_base/log/log';
import type { IModelCatalog } from '#/llm-adapter/model/catalog';
import { AGENT_ENVIRONMENT_TOOLS_FLAG_ID } from '#/features/environmentTools/flag';
import type { ISessionNotify } from '#/features/notify/sessionNotify';
import type { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { ISessionSubagentService } from '#/session/subagent/subagent';
import { ENVIRONMENT_EXPERIMENTAL_UNAVAILABLE } from '#/session/subagent/spawn';
import { SubagentTool } from '#/agent/tools/agent/agentTool';
import type { SubagentToolInput } from '#/agent/tools/agent/agent';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { stubFlag } from '../../../app/flag/stubs';
import { stubLog } from '../../../_base/log/stubs';

function buildTool(flags: IFlagService): SubagentTool {
  const catalog = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    list: () => [],
    getDefault: () => ({}),
    inspect: () => undefined,
  } as unknown as ISessionAgentProfileCatalog;
  return new SubagentTool(
    { handleOf: () => undefined } as unknown as IAgentLifecycleService,
    {} as ISessionSubagentService,
    catalog,
    { agentId: 'main' } as unknown as IAgentScopeContext,
    {} as IAgentTaskService,
    { data: () => ({}) } as unknown as IAgentProfileService,
    {} as IModelCatalog,
    { isToolActive: () => false } as unknown as IAgentToolPolicyService,
    { listReferences: () => [] } as unknown as IAgentToolRegistryService,
    {} as IAgentPermissionModeService,
    { read: async () => ({}) } as unknown as ISessionMetadata,
    stubLog() as unknown as ILogService,
    { get: () => undefined } as unknown as IConfigService,
    flags,
    { enabled: false } as unknown as ISessionNotify,
    { items: [] } as unknown as CollectionView<AgentToolContribution>,
  );
}

const INPUT: SubagentToolInput = {
  prompt: 'Review the file',
  description: 'review file',
  environment: 'staging',
};

describe('SubagentTool environment parameter flag gate', () => {
  it('rejects environment at execution time when the agent_environment_tools flag is off', async () => {
    const tool = buildTool(stubFlag(false));

    const result = await tool.resolveExecution({ ...INPUT });

    expect(result).toEqual({ output: ENVIRONMENT_EXPERIMENTAL_UNAVAILABLE, isError: true });
  });

  it('does not gate a resumed agent since resume ignores the environment parameter', async () => {
    const tool = buildTool(stubFlag(false));

    const result = await tool.resolveExecution({ ...INPUT, resume: 'agent-1' });

    expect(result).not.toEqual({ output: ENVIRONMENT_EXPERIMENTAL_UNAVAILABLE, isError: true });
    expect((result as ExecutableToolResult).isError).not.toBe(true);
  });

  it('accepts environment when the flag is on', async () => {
    const tool = buildTool(stubFlag((id) => id === AGENT_ENVIRONMENT_TOOLS_FLAG_ID));

    const result = await tool.resolveExecution({ ...INPUT });

    expect((result as ExecutableToolResult).isError).not.toBe(true);
  });
});
