/**
 * `fileTools` domain — WriteTool, the model's UTF-8 text file writer.
 *
 * Overwrites a file entirely or appends content to its end. Creates the file
 * if it does not exist, and creates missing parent directories automatically
 * (mirroring `mkdir(parents=True, exist_ok=True)`). Path access policy is
 * resolved before any filesystem I/O.
 *
 * Append uses `IHostFileSystem.appendText` (a native `O_APPEND`-style append),
 * so existing content is never read or rewritten — keeping appends atomic with
 * respect to concurrent writers and safe against mid-write crashes.
 *
 * Write access flows through the os `hostFs` domain (`IHostFileSystem`); path
 * semantics (home expansion, path class) come from the `hostEnvironment`
 * domain.
 *
 * Ported from v1 (`packages/agent-core/src/tools/builtin/file/write.ts`).
 */

import { dirname } from 'pathe';
import { z } from 'zod';

import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { type HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  ToolAccesses,
  type BuiltinTool,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import {
  extendWorkspaceWithSkillRoots,
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
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
  bytesWritten: z.number().int().nonnegative(),
});

export type WriteInput = z.infer<typeof WriteInputSchema>;
export type WriteOutput = z.infer<typeof WriteOutputSchema>;

export class WriteTool implements BuiltinTool<WriteInput> {
  readonly name = 'Write' as const;
  readonly description = WRITE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteInputSchema);

  constructor(
    @IHostFileSystem private readonly fs: IHostFileSystem,
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

  resolveExecution(args: WriteInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      env: this.env,
      workspace: this.workspaceConfig,
      operation: 'write',
    });
    return {
      accesses: ToolAccesses.writeFile(path),
      description: `Writing ${args.path}`,
      display: { kind: 'file_io', operation: 'write', path, content: args.content },
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

  private async execution(args: WriteInput, safePath: string): Promise<ExecutableToolResult> {
    const parentError = await this.ensureParentDirectory(safePath);
    if (parentError !== undefined) {
      return { isError: true, output: parentError };
    }

    try {
      const mode = args.mode ?? 'overwrite';
      if (mode === 'append') {
        await this.fs.appendText(safePath, args.content);
      } else {
        await this.fs.writeText(safePath, args.content);
      }
      const bytesWritten = Buffer.byteLength(args.content, 'utf8');
      return {
        output: `${mode === 'append' ? 'Appended' : 'Wrote'} ${String(bytesWritten)} bytes to ${args.path}`,
      };
    } catch (error) {
      const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
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

  private async ensureParentDirectory(safePath: string): Promise<string | undefined> {
    const parent = dirname(safePath);
    let stat: HostFileStat;
    try {
      stat = await this.fs.stat(parent);
    } catch (error) {
      if ((unwrapErrorCause(error) as { code?: unknown } | null)?.code === 'ENOENT') {
        try {
          await this.fs.mkdir(parent, { recursive: true });
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

registerTool(WriteTool);
