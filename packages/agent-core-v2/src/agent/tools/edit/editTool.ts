/**
 * `tools` domain — `EditTool` implementation, the Agent entry for exact
 * string replacement in a text file.
 *
 * Agent-scope adapter over the App-scope {@link IFileEditService} capability.
 * Keeps only the Agent-facing responsibilities: path resolution, the file
 * access declaration, the diff display, the approval rule, the no-op
 * pre-check, and mapping the domain-neutral `FileEditResult` into an
 * `ExecutableToolResult`. The actual read/edit/write is delegated to
 * {@link IFileEditService} (os-backed adapter over `IHostFileSystem`), which
 * runs the pure `TextModel` / `EditService` logic.
 *
 * Path semantics (home expansion, path class) come from the
 * `hostEnvironment` domain; the workspace and skill roots come from
 * `ISessionWorkspaceContext` / `ISessionSkillCatalog`.
 *
 * Ported from v1.
 * Bound at Agent scope; self-registers via `registerAgentToolService(...)` at module
 * load.
 */

import {
  extendWorkspaceWithSkillRoots,
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { IFileEditService } from '#/app/edit/fileEdit';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
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
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {}

  private get workspaceConfig(): WorkspaceConfig {
    return extendWorkspaceWithSkillRoots(
      {
        workspaceDir: this.workspaceCtx.workDir,
        additionalDirs: this.workspaceCtx.additionalDirs,
      },
      this.skillCatalog?.catalog.getSkillRoots() ?? [],
      this.env.pathClass,
    );
  }

  resolveExecution(args: EditInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      env: this.env,
      workspace: this.workspaceConfig,
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
          cwd: this.workspaceConfig.workspaceDir,
          pathClass: this.env.pathClass,
          homeDir: this.env.homeDir,
        }),
      execute: () => this.execution(args, path),
    };
  }

  private async execution(args: EditInput, safePath: string): Promise<ExecutableToolResult> {
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
    });
    if (!result.ok) {
      return { isError: true, output: result.error };
    }
    const word = result.count === 1 ? 'occurrence' : 'occurrences';
    return { output: `Replaced ${String(result.count)} ${word} in ${args.path}` };
  }
}

registerAgentToolService(IEditTool, EditTool, { name: 'Edit', domain: 'edit' });
