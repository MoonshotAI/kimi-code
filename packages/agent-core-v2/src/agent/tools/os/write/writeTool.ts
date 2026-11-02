import { dirname } from 'pathe';

import { type HostFileStat, type IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isHostFsNotFound } from '#/os/interface/hostFsErrors';
import { acquireOrWhenReady, IAgentEnvironmentService, pinnedGeneration } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentPlanService } from '#/features/plan/plan';
import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import {
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { IWriteTool, WriteInputSchema, type WriteInput } from './write';
import WRITE_DESCRIPTION from './write.md?raw';

export class WriteTool implements IWriteTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Write' as const;
  readonly description = WRITE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteInputSchema);

  constructor(
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
    @IAgentPlanService private readonly planService?: IAgentPlanService,
  ) {}

  private workspaceConfig(view: EnvironmentWorkspaceView): WorkspaceConfig {
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  async resolveExecution(args: WriteInput): Promise<ToolExecution> {
    const planTarget = await this.planService?.resolveFile(args.path);
    if (planTarget !== undefined) {
      const path = planTarget.path;
      return {
        accesses: ToolAccesses.writeFile(path),
        description: `Writing ${args.path}`,
        display: { kind: 'file_io', operation: 'write', path, content: args.content },
        approvalRule: literalRulePattern(this.name, path),
        matchesRule: (ruleArgs) => matchesPathRuleSubject(ruleArgs, path, {
          cwd: planTarget.environmentPath.dirname(path), pathClass: planTarget.pathClass,
        }),
        execute: async () => {
          const current = await this.planService?.resolveFile(path);
          if (current === undefined || current.path !== path) return { isError: true, output: 'The active plan changed before execution. Retry the tool call.' };
          return this.execution(current.fs, args, path, current.environmentPath.dirname(path));
        },
      };
    }
    const resolutionLease = await acquireOrWhenReady(this.environment, ['fs']);
    try {
      const inspected = resolutionLease.environment;
      const expectedGeneration = pinnedGeneration(inspected);
      const view = new EnvironmentWorkspaceView(inspected, {
        workDir: this.workspaceCtx.workDir,
        additionalDirs: [
          ...this.workspaceCtx.additionalDirs,
          ...(this.skillCatalog?.catalog.getSkillRoots() ?? []),
        ],
      });
      const env = { _serviceBrand: undefined, ...view.host, ready: Promise.resolve() };
      const workspace = this.workspaceConfig(view);
      const path = resolvePathAccessPath(args.path, {
        env,
        workspace,
        operation: 'write',
      });
      return {
        accesses: ToolAccesses.writeFile(path),
        description: `Writing ${args.path}`,
        display: { kind: 'file_io', operation: 'write', path, content: args.content },
        approvalRule: literalRulePattern(this.name, path),
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, path, {
            cwd: workspace.workspaceDir,
            pathClass: env.pathClass,
            homeDir: env.homeDir,
          }),
        execute: async () => {
          const lease = await acquireOrWhenReady(this.environment, ['fs']);
          try {
            if (expectedGeneration !== undefined && lease.environment.identity.generation !== expectedGeneration) {
              return { isError: true, output: 'Environment changed before execution. Retry the tool call.' };
            }
            return await this.execution(lease.environment.fs!, args, path);
          } finally {
            lease.dispose();
          }
        },
      };
    } finally {
      resolutionLease.dispose();
    }
  }

  private async execution(fs: IHostFileSystem, args: WriteInput, safePath: string, parent = dirname(safePath)): Promise<ExecutableToolResult> {
    const parentError = await this.ensureParentDirectory(fs, parent);
    if (parentError !== undefined) {
      return { isError: true, output: parentError };
    }

    try {
      const mode = args.mode ?? 'overwrite';
      if (mode === 'append') {
        await fs.appendText(safePath, args.content);
      } else {
        await fs.writeText(safePath, args.content);
      }
      const bytesWritten = Buffer.byteLength(args.content, 'utf8');
      return {
        output: `${mode === 'append' ? 'Appended' : 'Wrote'} ${String(bytesWritten)} bytes to ${args.path}`,
        note: '<system>The change is applied; there is no need to Read the file back to check it.</system>',
      };
    } catch (error) {
      if (isHostFsNotFound(error)) {
        return {
          isError: true,
          output: `Failed to write ${args.path}: parent directory does not exist.`,
        };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async ensureParentDirectory(fs: IHostFileSystem, parent: string): Promise<string | undefined> {
    let stat: HostFileStat;
    try {
      stat = await fs.stat(parent);
    } catch (error) {
      if (isHostFsNotFound(error)) {
        try {
          await fs.mkdir(parent, { recursive: true });
          return undefined;
        } catch (mkdirError) {
          return mkdirError instanceof Error ? mkdirError.message : String(mkdirError);
        }
      }
      return undefined;
    }
    if (!stat.isDirectory) {
      return `Parent path is not a directory: ${parent}.`;
    }
    return undefined;
  }
}

registerAgentToolService(IWriteTool, WriteTool, {
  name: 'Write',
  domain: 'os/backends',
  requiredEnvironmentCapabilities: ['fs'],
});
