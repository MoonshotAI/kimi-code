import {
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { IFileEditService } from '#/app/edit/fileEdit';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { Environment } from '#/environment/environment';
import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { acquireOrWhenReady, IAgentEnvironmentService, inspectAgentEnvironment, pinnedGeneration } from '#/agent/environmentBinding/agentEnvironment';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { EditInputSchema, IEditTool, type EditInput } from './edit';
import editDescriptionTemplate from './edit.md?raw';

export class EditTool implements IEditTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Edit' as const;
  readonly description = editDescriptionTemplate;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EditInputSchema);

  constructor(
    @IFileEditService private readonly editor: IFileEditService,
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {}

  private workspaceConfig(environment: Environment): WorkspaceConfig {
    const view = new EnvironmentWorkspaceView(environment, {
      workDir: this.workspaceCtx.workDir,
      additionalDirs: [
        ...this.workspaceCtx.additionalDirs,
        ...(this.skillCatalog?.catalog.getSkillRoots() ?? []),
      ],
    });
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  resolveExecution(args: EditInput): ToolExecution {
    const inspected = inspectAgentEnvironment(this.environment);
    const expectedGeneration = pinnedGeneration(inspected, ['fs']);
    const env = inspected.host;
    const workspace = this.workspaceConfig(inspected);
    const path = resolvePathAccessPath(args.path, {
      env,
      workspace,
      operation: 'write',
    });
    return {
      accesses: ToolAccesses.readWriteFile(path),
      description: `Editing ${args.path}`,
      display: {
        kind: 'file_io',
        operation: 'edit',
        path,
        before: args.old_string,
        after: args.new_string,
      },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: workspace.workspaceDir,
          pathClass: env.pathClass,
          homeDir: env.homeDir,
        }),
      execute: async () => {
        const acquired = acquireOrWhenReady(this.environment, ['fs']);
        const lease = isPromiseLike(acquired) ? await acquired : acquired;
        try {
          if (expectedGeneration !== undefined && lease.environment.identity.generation !== expectedGeneration) {
            return { isError: true, output: 'Environment changed before execution. Retry the tool call.' };
          }
          return await this.execution(args, path, lease.environment.fs!);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async execution(
    args: EditInput,
    safePath: string,
    fs: IHostFileSystem,
  ): Promise<ExecutableToolResult> {
    if (args.old_string === args.new_string) {
      return {
        isError: true,
        output: 'No changes to make: old_string and new_string are exactly the same.',
      };
    }

    const result = await this.editor.edit({
      path: safePath,
      displayPath: args.path,
      old_string: args.old_string,
      new_string: args.new_string,
      replace_all: args.replace_all ?? false,
    }, fs);
    if (!result.ok) {
      return { isError: true, output: result.error };
    }
    const word = result.count === 1 ? 'occurrence' : 'occurrences';
    return { output: `Replaced ${String(result.count)} ${word} in ${args.path}` };
  }
}

registerAgentToolService(IEditTool, EditTool, {
  name: 'Edit',
  domain: 'edit',
  requiredEnvironmentCapabilities: ['fs'],
});
