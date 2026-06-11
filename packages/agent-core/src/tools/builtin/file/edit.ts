/**
 * EditTool — exact string replacement in a file.
 *
 * Replaces the first occurrence of `old_string` with `new_string` by
 * default. When `replace_all` is true, replaces all occurrences.
 * Errors when `old_string` is not found or not unique (when
 * `replace_all=false`). Path access policy is resolved before any
 * Kaos I/O.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import { materializeModelText, toModelTextView } from './line-endings';
import EDIT_DESCRIPTION from './edit.md';

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

export type EditInput = z.Infer<typeof EditInputSchema>;

function replaceOnceLiteral(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString);
  if (index === -1) return content;
  return content.slice(0, index) + newString + content.slice(index + oldString.length);
}

/**
 * Attempt to fix common LLM backslash-encoding mistakes in a string.
 * Used for both old_string (matched against content) and new_string
 * (applied as replacement).
 */
function applyBackslashFix(
  input: string,
  variant: 'unescape' | 'escape',
): string {
  if (variant === 'unescape') {
    return input
      .replaceAll('\\n', '\n')
      .replaceAll('\\t', '\t')
      .replaceAll('\\r', '\r')
      .replaceAll('\\\\', '\\');
  }
  return input
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')
    .replaceAll('\r', '\\r');
}
function findBackslashAdjustedMatch(
  content: string,
  oldString: string,
): { adjusted: string; variant: 'unescape' | 'escape' } | undefined {
  const variants: Array<{ adjusted: string; variant: 'unescape' | 'escape' }> = [];

  const unescaped = applyBackslashFix(oldString, 'unescape');
  if (unescaped !== oldString) {
    variants.push({ adjusted: unescaped, variant: 'unescape' });
  }

  const overEscaped = applyBackslashFix(oldString, 'escape');
  if (overEscaped !== oldString && overEscaped !== unescaped) {
    variants.push({ adjusted: overEscaped, variant: 'escape' });
  }

  for (const v of variants) {
    if (content.includes(v.adjusted)) {
      return v;
    }
  }
  return undefined;
}

/**
 * Build a short diagnostic snippet showing the first divergence between
 * `oldString` and the file content, helpful when old_string is not found.
 */
function buildNotFoundHint(content: string, oldString: string, _filePath: string): string {
  const lines = content.split('\n');
  const firstLine = oldString.split('\n')[0] ?? '';
  if (firstLine.length === 0) return '';

  // Find the closest matching line in the file content.
  const candidates = lines.filter((l) => l.includes(firstLine.slice(0, 20)));
  if (candidates.length === 0) {
    return `The file does not contain a line matching the start of old_string: "${truncate(firstLine, 60)}"`;
  }
  return `Closest match in file: "${truncate(candidates[0]!, 80)}"`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

export class EditTool implements BuiltinTool<EditInput> {
  readonly name = 'Edit' as const;
  readonly description = EDIT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EditInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {}

  resolveExecution(args: EditInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      kaos: this.kaos,
      workspace: this.workspace,
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
          cwd: this.workspace.workspaceDir,
          pathClass: this.kaos.pathClass(),
          homeDir: this.kaos.gethome(),
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
      const raw = await this.kaos.readText(safePath);
      const modelView = toModelTextView(raw);
      const content = modelView.text;
      const replaceAll = args.replace_all ?? false;

      // Try the original old_string first; if not found, attempt backslash
      // encoding fixes that cover common LLM mis-encodings.
      let oldString = args.old_string;
      let newString = args.new_string;
      let backslashHint: string | undefined;
      if (!content.includes(oldString)) {
        const adjusted = findBackslashAdjustedMatch(content, oldString);
        if (adjusted !== undefined) {
          oldString = adjusted.adjusted;
          newString = applyBackslashFix(newString, adjusted.variant);
          backslashHint = ` (matched after ${adjusted.variant} adjustment)`;
        }
      }

      if (!replaceAll) {
        let count = 0;
        let pos = 0;
        while (pos < content.length) {
          const idx = content.indexOf(oldString, pos);
          if (idx === -1) break;
          count++;
          pos = idx + oldString.length;
        }

        if (count === 0) {
          const hint = buildNotFoundHint(content, oldString, args.path);
          return { isError: true, output: `old_string not found in ${args.path}. ${hint}\nThe file contents may be out of date. Please use the Read Tool to reload the content.
` };
        }
        if (count > 1) {
          return {
            isError: true,
            output:
              `old_string is not unique in ${args.path} (found ${String(count)} occurrences). ` +
              'To replace every occurrence, set replace_all=true. To replace only one occurrence, include more surrounding context in old_string.',
          };
        }

        const newContent = replaceOnceLiteral(content, oldString, newString);
        await this.kaos.writeText(
          safePath,
          materializeModelText(newContent, modelView.lineEndingStyle),
        );
        return { output: `Replaced 1 occurrence in ${args.path}${backslashHint ?? ''}` };
      }

      const parts = content.split(oldString);
      const replacementCount = parts.length - 1;
      if (replacementCount === 0) {
        const hint = buildNotFoundHint(content, oldString, args.path);
        return { isError: true, output: `old_string not found in ${args.path}. ${hint}\nThe file contents may be out of date. Please use the Read Tool to reload the content.
` };
      }

      const newContent = parts.join(newString);
      await this.kaos.writeText(
        safePath,
        materializeModelText(newContent, modelView.lineEndingStyle),
      );
      return { output: `Replaced ${String(replacementCount)} occurrences in ${args.path}${backslashHint ?? ''}` };
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
