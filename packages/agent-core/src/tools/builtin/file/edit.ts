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
  variant: 'collapse-only' | 'escape' | 'unescape-seq-first',
): string {
  if (variant === 'collapse-only') {
    // Only collapse doubled backslashes — no escape sequence processing.
    // Handles: LLM sent \\\\n (two backslashes + n) but file has \n (one backslash + n).
    return input.replaceAll('\\\\', '\\');
  }
  if (variant === 'escape') {
    // Replace real newlines with backslash-n.
    // Handles: LLM sent \n (real newline) but file has \\n (two backslashes + n).
    return input
      .replaceAll('\n', '\\n')
      .replaceAll('\t', '\\t')
      .replaceAll('\r', '\\r');
  }
  // unescape-seq-first: translate escape sequences first, then collapse.
  // Handles: LLM sent \n (real newline) but file has \n (backslash + n).
  return input
    .replaceAll('\\n', '\n')
    .replaceAll('\\t', '\t')
    .replaceAll('\\r', '\r')
    .replaceAll('\\\\', '\\');
}

function findBackslashAdjustedMatch(
  content: string,
  oldString: string,
): { adjusted: string; variant: string } | undefined {
  // Try all variants and return the first that matches the file content.
  const candidates: Array<{ adjusted: string; variant: string }> = [
    { adjusted: applyBackslashFix(oldString, 'collapse-only'), variant: 'collapse-only' },
    { adjusted: applyBackslashFix(oldString, 'escape'), variant: 'escape' },
    { adjusted: applyBackslashFix(oldString, 'unescape-seq-first'), variant: 'unescape-seq-first' },
  ];
  for (const c of candidates) {
    if (c.adjusted !== oldString && content.includes(c.adjusted)) {
      return c;
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

  async resolveExecution(args: EditInput): Promise<ToolExecution> {
    const path = resolvePathAccessPath(args.path, {
      kaos: this.kaos,
      workspace: this.workspace,
      operation: 'write',
    });

    // Reject no-op edits before any file I/O.
    if (args.old_string === args.new_string) {
      return {
        isError: true,
        output: 'No changes to make: old_string and new_string are exactly the same.',
      };
    }

    // Read the file and apply backslash fallback early, so the approval
    // display shows the exact text that will be written.
    let adjustedArgs = args;
    try {
      const raw = await this.kaos.readText(path);
      const content = toModelTextView(raw).text;
      if (!content.includes(args.old_string)) {
        const adjusted = findBackslashAdjustedMatch(content, args.old_string);
        if (adjusted !== undefined) {
          adjustedArgs = {
            ...args,
            old_string: adjusted.adjusted,
            new_string: applyBackslashFix(
              args.new_string,
              adjusted.variant as 'escape' | 'collapse-only' | 'unescape-seq-first',
            ),
          };
        }
      }
    } catch {
      // If we can't read the file here, execution() will handle it.
    }

    return {
      accesses: ToolAccesses.readWriteFile(path),
      description: `Editing ${args.path}`,
      display: {
        kind: 'file_io',
        operation: 'edit',
        path,
        before: adjustedArgs.old_string,
        after: adjustedArgs.new_string,
      },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.kaos.pathClass(),
          homeDir: this.kaos.gethome(),
        }),
      execute: () => this.execution(adjustedArgs, path),
    };
  }

  private async execution(args: EditInput, safePath: string): Promise<ExecutableToolResult> {
    try {
      const raw = await this.kaos.readText(safePath);
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
          const hint = buildNotFoundHint(content, args.old_string, args.path);
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

        const newContent = replaceOnceLiteral(content, args.old_string, args.new_string);
        await this.kaos.writeText(
          safePath,
          materializeModelText(newContent, modelView.lineEndingStyle),
        );
        return { output: `Replaced 1 occurrence in ${args.path}` };
      }

      const parts = content.split(args.old_string);
      const replacementCount = parts.length - 1;
      if (replacementCount === 0) {
        const hint = buildNotFoundHint(content, args.old_string, args.path);
        return { isError: true, output: `old_string not found in ${args.path}. ${hint}\nThe file contents may be out of date. Please use the Read Tool to reload the content.
` };
      }

      const newContent = parts.join(args.new_string);
      await this.kaos.writeText(
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
