import { dirname } from 'pathe';

import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core';

import {
  unwrapErrorCause,
  type HostFileStat,
  type OsFsPort,
  type OsHost,
} from '#/features/os/host/types';
import { PathSecurityError, resolvePathAccessPath } from '#/features/os/path-access';
import WRITE_DESCRIPTION from './write.md?raw';

export const WRITE_TOOL_NAME = 'Write';

export interface CreateWriteToolProps {
  readonly host: OsHost;
  readonly workspace: {
    readonly workDir: string;
    readonly additionalDirs?: readonly string[];
  };
}

interface WriteArguments {
  path: string;
  content: string;
  mode?: 'overwrite' | 'append';
}

function parseWriteArguments(
  raw: string | null,
): { args: WriteArguments; parseError?: undefined } | { args?: undefined; parseError: string } {
  let parsed: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { parseError: `invalid Write arguments: ${raw}` };
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { parseError: `invalid Write arguments: ${raw}` };
  }
  const { path, content, mode } = parsed as {
    path?: unknown;
    content?: unknown;
    mode?: unknown;
  };
  if (typeof path !== 'string' || path.length === 0) {
    return { parseError: `invalid Write arguments: ${raw}` };
  }
  if (typeof content !== 'string') {
    return { parseError: `invalid Write arguments: ${raw}` };
  }
  if (mode !== undefined && mode !== 'overwrite' && mode !== 'append') {
    return { parseError: `invalid Write arguments: ${raw}` };
  }
  return { args: { path, content, mode } };
}

async function ensureParentDirectory(fs: OsFsPort, safePath: string): Promise<string | undefined> {
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

export function createWriteTool(props: CreateWriteToolProps): ToolDefinition {
  const executeWrite = async (
    args: WriteArguments,
    safePath: string,
  ): Promise<{ text: string; isError?: true }> => {
    const parentError = await ensureParentDirectory(props.host.fs, safePath);
    if (parentError !== undefined) {
      return { text: parentError, isError: true };
    }

    try {
      const mode = args.mode ?? 'overwrite';
      if (mode === 'append') {
        await props.host.fs.appendText(safePath, args.content);
      } else {
        await props.host.fs.writeText(safePath, args.content);
      }
      const bytesWritten = Buffer.byteLength(args.content, 'utf8');
      return {
        text: `${mode === 'append' ? 'Appended' : 'Wrote'} ${String(bytesWritten)} bytes to ${args.path}`,
      };
    } catch (error) {
      const code = (unwrapErrorCause(error) as { code?: unknown } | null)?.code;
      if (code === 'ENOENT') {
        return {
          text: `Failed to write ${args.path}: parent directory does not exist.`,
          isError: true,
        };
      }
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  };

  return {
    name: WRITE_TOOL_NAME,
    description: WRITE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically.',
        },
        content: {
          type: 'string',
          description:
            'Raw full file content to write exactly as provided. This does not use the Read/Edit text view.',
        },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description:
            'Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async execute({ toolCall }): Promise<ToolResult> {
      const errorText = (value: string): ToolResult => ({
        content: [{ type: 'text' as const, text: value }],
        isError: true,
      });
      const parsed = parseWriteArguments(toolCall.arguments);
      if (parsed.parseError !== undefined) {
        return errorText(parsed.parseError);
      }
      const args = parsed.args;
      await props.host.environment.ready;
      let safePath: string;
      try {
        safePath = resolvePathAccessPath(args.path, {
          env: props.host.environment,
          workspace: {
            workspaceDir: props.workspace.workDir,
            additionalDirs: props.workspace.additionalDirs ?? [],
          },
          operation: 'write',
        });
      } catch (error) {
        if (error instanceof PathSecurityError) {
          return errorText(error.message);
        }
        throw error;
      }
      const finished = await executeWrite(args, safePath);
      return {
        content: [{ type: 'text' as const, text: finished.text }],
        isError: finished.isError,
      };
    },
  };
}
