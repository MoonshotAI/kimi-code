import { dirname } from 'pathe';

import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isHostFsNotFound } from '#/os/interface/hostFsErrors';
import { acquireOrWhenReady, IAgentEnvironmentService, pinnedGeneration } from '#/agent/environmentBinding/agentEnvironment';
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
import { checkRealPathWriteTarget } from '#/tool/realpath-access';
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
  ) {}

  private workspaceConfig(view: EnvironmentWorkspaceView): WorkspaceConfig {
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  resolveExecution(args: WriteInput): ToolExecution {
    const inspected = this.environment.inspect();
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
          const accessError = await checkRealPathWriteTarget(lease.environment.fs!, path, workspace, env.pathClass);
          if (accessError !== undefined) {
            return { isError: true, output: accessError.message };
          }
          return await this.execution(lease.environment.fs!, args, path);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async execution(fs: IHostFileSystem, args: WriteInput, safePath: string): Promise<ExecutableToolResult> {
    const parentError = await this.ensureParentDirectory(fs, safePath);
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

  private async ensureParentDirectory(fs: IHostFileSystem, safePath: string): Promise<string | undefined> {
    const parent = dirname(safePath);
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
