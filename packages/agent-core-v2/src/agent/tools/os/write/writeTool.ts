import { dirname, isAbsolute, relative } from 'pathe';

import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { unwrapErrorCause } from '#/_base/errors/errors';
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
import {
  byteOrderMarkBytes,
  decodeUtfText,
  encodeUtfText,
  isStrictlyValidUtf16,
  isStrictlyValidUtf8,
  SAMPLE_LOOKAHEAD_BYTES,
  splitByteOrderMark,
  type ByteOrderMark,
} from '#/_base/text/encoding';
import { dominantLineEnding, normalizeLineEndings } from '#/_base/text/line-endings';
import { resolveNewFileEditorStyle, type NewFileLineBreak } from './editorconfig';
import { resolveSiblingStyle } from './siblingStyle';
import { IWriteTool, WriteInputSchema, type WriteInput } from './write';
import WRITE_DESCRIPTION from './write.md?raw';

const STYLE_SAMPLE_BYTES = 8 * 1024;
const BOM_RESERVE_BYTES = 3;
const STYLE_SAMPLE_LIMIT = STYLE_SAMPLE_BYTES + SAMPLE_LOOKAHEAD_BYTES;

interface ExistingFileStyle {
  readonly bom: ByteOrderMark | 'none' | undefined;
  readonly eol: NewFileLineBreak | undefined;
}

const NO_STYLE: ExistingFileStyle = { bom: undefined, eol: undefined };

function isNotFoundError(error: unknown): boolean {
  return (unwrapErrorCause(error) as { code?: unknown } | null)?.code === 'ENOENT';
}

function isPathWithin(ancestor: string, descendant: string): boolean {
  const rel = relative(ancestor, descendant);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel))
  );
}

function styleContent(
  content: string,
  style: ExistingFileStyle,
): { text: string; payload: Uint8Array } {
  const text = style.eol === undefined ? content : normalizeLineEndings(content, style.eol);
  if (style.bom === undefined) {
    return { text, payload: Buffer.from(text, 'utf8') };
  }
  if (style.bom === 'none') {
    const stripped = text.startsWith('\uFEFF') ? text.slice(1) : text;
    return { text: stripped, payload: Buffer.from(stripped, 'utf8') };
  }
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const payload = Buffer.concat([
    Buffer.from(byteOrderMarkBytes(style.bom)),
    Buffer.from(encodeUtfText(body, style.bom)),
  ]);
  return { text, payload };
}

export class WriteTool implements IWriteTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Write' as const;
  readonly description = WRITE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WriteInputSchema);

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
  ) {}

  private workspaceConfig(view: RuntimeWorkspaceView): WorkspaceConfig {
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  resolveExecution(args: WriteInput): ToolExecution {
    const inspected = inspectAgentRuntime(this.runtime);
    const view = new RuntimeWorkspaceView(inspected, {
      workDir: this.workspaceCtx.workDir,
      additionalDirs: [
        ...this.workspaceCtx.additionalDirs,
        ...(this.skillCatalog?.catalog.getSkillRoots() ?? []),
      ],
    });
    const env = { _serviceBrand: undefined, ...inspected.environment, ready: Promise.resolve() };
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
        const lease = this.runtime.acquire(['fs']);
        try {
          if (lease.runtime.identity.generation !== inspected.identity.generation) {
            return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
          }
          return await this.execution(lease.runtime.fs!, args, path, view.roots);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async execution(
    fs: IHostFileSystem,
    args: WriteInput,
    safePath: string,
    workspaceRoots: readonly string[],
  ): Promise<ExecutableToolResult> {
    const parentError = await this.ensureParentDirectory(fs, safePath);
    if (parentError !== undefined) {
      return { isError: true, output: parentError };
    }

    try {
      const mode = args.mode ?? 'overwrite';
      if (mode === 'append') {
        if (await this.targetExists(fs, safePath)) {
          await fs.appendText(safePath, args.content);
          return {
            output: `Appended ${String(Buffer.byteLength(args.content, 'utf8'))} bytes to ${args.path}`,
          };
        }
        const style = await this.resolveNewFileStyle(fs, safePath, workspaceRoots);
        const { payload } = styleContent(args.content, style);
        if (await fs.createExclusive(safePath, payload)) {
          return {
            output: `Appended ${String(payload.length)} bytes to ${args.path}`,
          };
        }
        await fs.appendText(safePath, args.content);
        return {
          output: `Appended ${String(Buffer.byteLength(args.content, 'utf8'))} bytes to ${args.path}`,
        };
      }
      const bytesWritten = await this.overwrite(fs, safePath, args.content, workspaceRoots);
      return {
        output: `Wrote ${String(bytesWritten)} bytes to ${args.path}`,
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

  private async overwrite(
    fs: IHostFileSystem,
    safePath: string,
    content: string,
    workspaceRoots: readonly string[],
  ): Promise<number> {
    const style =
      (await this.sampleExistingStyle(fs, safePath)) ??
      (await this.resolveNewFileStyle(fs, safePath, workspaceRoots));
    return this.writeStyled(fs, safePath, content, style);
  }

  private async targetExists(fs: IHostFileSystem, safePath: string): Promise<boolean> {
    try {
      await fs.stat(safePath);
      return true;
    } catch (error) {
      return !isNotFoundError(error);
    }
  }

  private async writeStyled(
    fs: IHostFileSystem,
    safePath: string,
    content: string,
    style: ExistingFileStyle,
  ): Promise<number> {
    const { text, payload } = styleContent(content, style);
    if (style.bom === undefined || style.bom === 'none') {
      await fs.writeText(safePath, text);
      return payload.length;
    }
    await fs.writeBytes(safePath, payload);
    return payload.length;
  }

  private async sampleExistingStyle(
    fs: IHostFileSystem,
    safePath: string,
  ): Promise<ExistingFileStyle | undefined> {
    const readLimit = STYLE_SAMPLE_LIMIT + BOM_RESERVE_BYTES + 1;
    let head: Uint8Array;
    try {
      head = await fs.readBytes(safePath, readLimit);
    } catch (error) {
      return isNotFoundError(error) ? undefined : NO_STYLE;
    }
    const eof = head.length < readLimit;
    const { bom, body } = splitByteOrderMark(head);
    if (bom === undefined || bom === 'utf-8') {
      if (!isStrictlyValidUtf8(body, eof)) {
        return NO_STYLE;
      }
    } else if (!isStrictlyValidUtf16(body, bom, eof)) {
      return NO_STYLE;
    }
    const text = decodeUtfText(body, bom ?? 'utf-8');
    return { bom: bom ?? 'none', eol: dominantLineEnding(text) };
  }

  private async resolveNewFileStyle(
    fs: IHostFileSystem,
    safePath: string,
    workspaceRoots: readonly string[],
  ): Promise<ExistingFileStyle> {
    const editor = await resolveNewFileEditorStyle(
      fs,
      safePath,
      this.editorConfigStopDir(safePath, workspaceRoots),
    );
    if (editor.eol !== undefined && editor.bom !== undefined) {
      return { bom: editor.bom === false ? 'none' : editor.bom, eol: editor.eol };
    }
    const siblings = await resolveSiblingStyle(fs, safePath);
    return {
      bom: editor.bom === false ? 'none' : (editor.bom ?? siblings.bom),
      eol: editor.eol ?? siblings.eol,
    };
  }

  private editorConfigStopDir(safePath: string, workspaceRoots: readonly string[]): string {
    const dir = dirname(safePath);
    let stop: string | undefined;
    for (const root of workspaceRoots) {
      if (!isPathWithin(root, dir)) continue;
      if (stop === undefined || isPathWithin(root, stop)) stop = root;
    }
    return stop ?? dir;
  }

  private async ensureParentDirectory(fs: IHostFileSystem, safePath: string): Promise<string | undefined> {
    const parent = dirname(safePath);
    let stat: HostFileStat;
    try {
      stat = await fs.stat(parent);
    } catch (error) {
      if ((unwrapErrorCause(error) as { code?: unknown } | null)?.code === 'ENOENT') {
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
  requiredRuntimeCapabilities: ['fs'],
});
