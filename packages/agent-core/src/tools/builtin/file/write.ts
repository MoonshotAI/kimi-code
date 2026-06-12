/**
 * WriteTool — overwrite or append to a file.
 *
 * Creates the file if it does not exist; parent directory must already exist.
 * Path access policy is resolved before any Kaos I/O.
 */

import type { Kaos } from '@moonshot-ai/kaos';
import { dirname } from 'pathe';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { resolvePathAccessPath } from '../../policies/path-access';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import WRITE_DESCRIPTION from './write.md?raw';

/** Mask isolating the file-type bits of a stat mode. */
const S_IFMT = 0o170000;
/** File-type bits of a directory. */
const S_IFDIR = 0o040000;

export const WriteInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. The parent directory must already exist.',
    ),
  content: z
    .string()
    .describe(
      'Raw full file content to write exactly as provided. This does not use the Read/Edit text view.',
    ),
  mode: z
    .enum(['overwrite', 'append'])
    .optional()
    .describe(
      'Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.',
    ),
});

export const WriteOutputSchema = z.object({
  /** Number of UTF-8 bytes written to disk by this call. */
  bytesWritten: z.number().int().nonnegative(),
});

export type WriteInput = z.Infer<typeof WriteInputSchema>;
export type WriteOutput = z.Infer<typeof WriteOutputSchema>;

export class WriteTool implements BuiltinTool<WriteInput> {
  readonly name = 'Write' as const;
  readonly description = WRITE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteInputSchema);

  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
  ) {}

  resolveExecution(args: WriteInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      kaos: this.kaos,
      workspace: this.workspace,
      operation: 'write',
    });
    return {
      accesses: ToolAccesses.writeFile(path),
      description: `Writing ${args.path}`,
      display: { kind: 'file_io', operation: 'write', path, content: args.content },
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

  private async execution(args: WriteInput, safePath: string): Promise<ExecutableToolResult> {
    const parentError = await this.checkParentDirectory(safePath);
    if (parentError !== undefined) {
      return { isError: true, output: parentError };
    }

    try {
      const mode = args.mode ?? 'overwrite';
      if (mode === 'append') {
        await this.kaos.writeText(safePath, args.content, { mode: 'a' });
      } else {
        await this.kaos.writeText(safePath, args.content);
      }
      // Report the number of UTF-8 bytes this call wrote to disk. The string
      // length would only equal the byte count for pure ASCII content, so it
      // is not used here.
      const bytesWritten = Buffer.byteLength(args.content, 'utf8');
      return {
        output: `${mode === 'append' ? 'Appended' : 'Wrote'} ${String(bytesWritten)} bytes to ${args.path}`,
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT') {
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

  /**
   * Best-effort check that the parent directory exists and is a directory.
   *
   * The path schema documents this precondition; probing it up front turns a
   * bare `ENOENT` from the underlying write into an actionable message.
   * Returns an error string when the precondition is definitively violated,
   * or `undefined` otherwise. Any other `stat` failure (permissions, an
   * environment without `stat`) is treated as inconclusive: the check is
   * skipped and the write proceeds, surfacing the real I/O error if any.
   */
  private async checkParentDirectory(safePath: string): Promise<string | undefined> {
    const parent = dirname(safePath);
    let stat;
    try {
      stat = await this.kaos.stat(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return `Parent directory does not exist: ${parent}. Create it before writing this file.`;
      }
      return undefined;
    }
    if ((stat.stMode & S_IFMT) !== S_IFDIR) {
      return `Parent path is not a directory: ${parent}.`;
    }
    return undefined;
  }
}
