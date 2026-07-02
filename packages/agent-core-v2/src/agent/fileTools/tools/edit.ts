/**
 * `fileTools` domain — EditTool, exact string replacement in a text file.
 *
 * Replaces the first occurrence of `old_string` with `new_string` by default.
 * When `replace_all` is true, replaces every occurrence. Errors when
 * `old_string` is not found or not unique (when `replace_all` is false).
 *
 * Line endings are preserved: the raw file is normalized to the LF "model
 * view" for matching (so pure CRLF files can be edited with LF `old_string`),
 * then re-materialized to the original line-ending style on write — pure CRLF
 * files round-trip to CRLF, mixed/lone-CR files stay on the exact raw path.
 *
 * Path access policy is resolved before any filesystem I/O. Edit access flows
 * through the `agentFs` domain; path semantics (home expansion, path class)
 * come from the `hostEnvironment` domain.
 *
 * Ported from v1 (`packages/agent-core/src/tools/builtin/file/edit.ts`): the
 * `kaos.readText` / `kaos.writeText` calls become `fs.readText` /
 * `fs.writeText` against `ISessionAgentFileSystem`, and the path-class /
 * home-directory facts come from `IHostEnvironment`.
 */

import { z } from 'zod';

import { resolvePathAccessPath } from '#/_base/tools/policies/path-access';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/_base/tools/support/rule-match';
import type { WorkspaceConfig } from '#/_base/tools/support/workspace';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { ISessionAgentFileSystem } from '#/session/agentFs';
import { IHostEnvironment } from '#/app/hostEnvironment';
import { ToolAccesses } from '#/agent/tool';
import type { BuiltinTool, ExecutableToolResult, ToolExecution } from '#/agent/tool';

import editDescriptionTemplate from './edit.md?raw';
import { materializeModelText, toModelTextView } from './line-endings';

// `old_string` must be non-empty: the non-replace_all branch walks
// occurrences with `content.indexOf("", pos)`, which would loop forever
// on an empty search string.
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

const EDIT_DESCRIPTION = renderPrompt(editDescriptionTemplate, {});

function replaceOnceLiteral(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString);
  if (index === -1) return content;
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

export class EditTool implements BuiltinTool<EditInput> {
  readonly name = 'Edit' as const;
  readonly description = EDIT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EditInputSchema);

  constructor(
    private readonly fs: ISessionAgentFileSystem,
    private readonly env: IHostEnvironment,
    private readonly workspace: WorkspaceConfig,
  ) {}

  resolveExecution(args: EditInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      env: this.env,
      workspace: this.workspace,
      operation: 'write',
    });
    return {
      accesses: ToolAccesses.writeFile(path),
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
          cwd: this.workspace.workspaceDir,
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

    try {
      const raw = await this.fs.readText(safePath);
      const modelView = toModelTextView(raw);
      const content = modelView.text;
      const replaceAll = args.replace_all ?? false;

      if (!replaceAll) {
        let count = 0;
        let pos = 0;
        while (pos < content.length) {
          const idx = content.indexOf(args.old_string, pos);
          if (idx === -1) break;
          count++;
          pos = idx + args.old_string.length;
        }

        if (count === 0) {
          return {
            isError: true,
            output: `old_string not found in ${args.path}, the file contents may be out of date. Please use the Read Tool to reload the content.
`,
          };
        }
        if (count > 1) {
          return {
            isError: true,
            output:
              `old_string is not unique in ${args.path} (found ${String(count)} occurrences). ` +
              'To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.',
          };
        }

        const newContent = replaceOnceLiteral(content, args.old_string, args.new_string);
        await this.fs.writeText(
          safePath,
          materializeModelText(newContent, modelView.lineEndingStyle),
        );
        return { output: `Replaced 1 occurrence in ${args.path}` };
      }

      const parts = content.split(args.old_string);
      const replacementCount = parts.length - 1;
      if (replacementCount === 0) {
        return {
          isError: true,
          output: `old_string not found in ${args.path}, the file contents may be out of date. Please use the Read Tool to reload the content.
`,
        };
      }

      const newContent = parts.join(args.new_string);
      await this.fs.writeText(
        safePath,
        materializeModelText(newContent, modelView.lineEndingStyle),
      );
      return { output: `Replaced ${String(replacementCount)} occurrences in ${args.path}` };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'EISDIR') {
        return { isError: true, output: `${args.path} is not a file.` };
      }
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
