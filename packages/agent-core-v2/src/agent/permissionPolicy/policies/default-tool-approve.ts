import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';

const DEFAULT_APPROVE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'CronList',
  'WebSearch',
  'FetchURL',
  'Agent',
  'AgentSwarm',
  'AskUserQuestion',
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'FlowStart',
  'FlowAdvance',
  'FlowAbort',
  'FlowJump',
  'CreateGoal',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
  'select_tools',
]);

const BUILTIN_ONLY_TOOLS = new Set(['FlowStart', 'FlowAdvance', 'FlowAbort', 'FlowJump']);

export class DefaultToolApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'default-tool-approve';

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const name = context.toolCall.name;
    if (!DEFAULT_APPROVE_TOOLS.has(name)) return undefined;
    if (BUILTIN_ONLY_TOOLS.has(name)) {
      const source = this.toolRegistry
        .listReferences()
        .find((reference) => reference.name === name)?.source;
      if (source !== 'builtin') return undefined;
    }
    return { kind: 'approve' };
  }
}
