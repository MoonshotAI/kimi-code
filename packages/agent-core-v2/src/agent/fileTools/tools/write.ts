/**
 * `fileTools` domain — WriteTool, the model's UTF-8 text file writer.
 *
 * Overwrites a file entirely or appends content to its end. Creates the file
 * if it does not exist, and creates missing parent directories automatically
 * (mirroring `mkdir(parents=True, exist_ok=True)`). Path access policy is
 * resolved before any filesystem I/O.
 *
 * v2's `ISessionAgentFileSystem.writeText` has no mode flag: overwrite maps to a
 * direct write, while append reads the existing content first (treating a
 * missing file as empty) and writes the concatenation back.
 *
 * Write access flows through the `agentFs` domain; path semantics (home
 * expansion, path class) come from the `hostEnvironment` domain.
 *
 * Ported from v1 (`packages/agent-core/src/tools/builtin/file/write.ts`).
 */

import { dirname } from 'pathe';
import { z } from 'zod';

import type { AgentFileStat, ISessionAgentFileSystem } from '#/session/agentFs';
import { IHostEnvironment } from '#/app/hostEnvironment';
import { ToolAccesses } from '#/agent/tool';
import type { BuiltinTool, ExecutableToolResult, ToolExecution } from '#/agent/tool';
import { resolvePathAccessPath } from '#/_base/tools/policies/path-access';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/_base/tools/support/rule-match';
import type { WorkspaceConfig } from '#/_base/tools/support/workspace';
import WRITE_DESCRIPTION from './write.md?raw';

export const WriteInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically.',
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

export type WriteInput = z.infer<typeof WriteInputSchema>;
export type WriteOutput = z.infer<typeof WriteOutputSchema>;

export class WriteTool implements BuiltinTool<WriteInput> {
  readonly name = 'Write' as const;
  readonly description = WRITE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteInputSchema);

  constructor(
    private readonly fs: ISessionAgentFileSystem,
    private readonly env: IHostEnvironment,
    private readonly workspace: WorkspaceConfig,
  ) {}

  resolveExecution(args: WriteInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      env: this.env,
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
          pathClass: this.env.pathClass,
          homeDir: this.env.homeDir,
        }),
      execute: () => this.execution(args, path),
    };
  }

  private async execution(args: WriteInput, safePath: string): Promise<ExecutableToolResult> {
    const parentError = await this.ensureParentDirectory(safePath);
    if (parentError !== undefined) {
      return { isError: true, output: parentError };
    }

    try {
      const mode = args.mode ?? 'overwrite';
      if (mode === 'append') {
        let existing = '';
        try {
          existing = await this.fs.readText(safePath);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code !== 'ENOENT') throw error;
        }
        await this.fs.writeText(safePath, existing + args.content);
      } else {
        await this.fs.writeText(safePath, args.content);
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
   * Best-effort check that the parent directory is usable, creating it when
   * it is missing.
   *
   * If the parent (or any ancestor) does not exist, it is created
   * recursively — mirroring Python's `Path.mkdir(parents=True,
   * exist_ok=True)` — so the agent does not need a separate `mkdir` round
   * trip before writing into a fresh subfolder. An existing parent that is
   * not a directory is still a hard error. Any other `stat` failure
   * (permissions, an environment without `stat`) is treated as
   * inconclusive: the check is skipped and the write proceeds, surfacing
   * the real I/O error if any.
   *
   * Returns an error string when the precondition is definitively violated,
   * or `undefined` otherwise.
   */
  private async ensureParentDirectory(safePath: string): Promise<string | undefined> {
    const parent = dirname(safePath);
    let stat: AgentFileStat;
    try {
      stat = await this.fs.stat(parent);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
        try {
          await this.fs.mkdir(parent);
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
