/**
 * `edit` domain (L4) — {@link EditTool}, the Agent entry for exact string
 * replacement in a text file.
 *
 * Agent-scope adapter over the App-scope {@link IFileEditService} capability.
 * Keeps only the Agent-facing responsibilities: path resolution, the file
 * access declaration, the diff display, the approval rule, the no-op
 * pre-check, and mapping the domain-neutral `FileEditResult` into an
 * `ExecutableToolResult`. The actual read/edit/write is delegated to
 * {@link IFileEditService} (os-backed adapter over `IHostFileSystem`), which
 * runs the pure `TextModel` / `EditService` logic.
 *
 * Line endings are preserved by the model view: the raw file is normalized to
 * LF for matching (so pure CRLF files can be edited with LF `old_string`),
 * then re-materialized to the original style on write — pure CRLF files
 * round-trip to CRLF, mixed/lone-CR files stay on the exact raw path.
 *
 * Ported from v1 (`packages/agent-core/src/tools/builtin/file/edit.ts`).
 */

import { z } from 'zod';

import {
  extendWorkspaceWithSkillRoots,
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { IFileEditService } from '../fileEdit';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  ToolAccesses,
  type BuiltinTool,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import editDescriptionTemplate from './edit.md?raw';

export const EditInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute.',
    ),
  old_string: z
    .string()
    .min(1)
    .describe(
      'Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\r escapes where Read shows \\r.',
    ),
  new_string: z
    .string()
    .describe(
      'Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files.',
    ),
  replace_all: z
    .boolean()
    .optional()
    .describe('Set true only when every occurrence of old_string should be replaced.'),
});

export type EditInput = z.infer<typeof EditInputSchema>;

export class EditTool implements BuiltinTool<EditInput> {
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

registerTool(EditTool);
