import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core';

import { createNodeOsHost, type OsHost } from '#/features/os/host/index';
import { PathSecurityError, resolvePathAccessPath } from '#/features/os/path-access';

import DESCRIPTION from './edit.md?raw';
import { editFile } from './service';

export const EDIT_TOOL_NAME = 'Edit';

export interface CreateEditToolProps {
  readonly workDir: string;
  readonly host?: OsHost;
}

interface EditArguments {
  path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

function parseEditArguments(
  raw: string | null,
): { args: EditArguments; parseError?: undefined } | { args?: undefined; parseError: string } {
  let parsed: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { parseError: `invalid Edit arguments: ${raw}` };
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { parseError: `invalid Edit arguments: ${raw}` };
  }
  const { path, old_string, new_string, replace_all } = parsed as {
    path?: unknown;
    old_string?: unknown;
    new_string?: unknown;
    replace_all?: unknown;
  };
  if (typeof path !== 'string' || path.length === 0) {
    return { parseError: `invalid Edit arguments: ${raw}` };
  }
  if (typeof old_string !== 'string' || old_string.length === 0) {
    return { parseError: `invalid Edit arguments: ${raw}` };
  }
  if (typeof new_string !== 'string') {
    return { parseError: `invalid Edit arguments: ${raw}` };
  }
  if (replace_all !== undefined && typeof replace_all !== 'boolean') {
    return { parseError: `invalid Edit arguments: ${raw}` };
  }
  return {
    args: { path, old_string, new_string, replace_all: replace_all ?? false },
  };
}

export function createEditTool(props: CreateEditToolProps): ToolDefinition {
  const host = props.host ?? createNodeOsHost();
  return {
    name: EDIT_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute.',
        },
        old_string: {
          type: 'string',
          minLength: 1,
          description:
            'Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\r escapes where Read shows \\r.',
        },
        new_string: {
          type: 'string',
          description:
            'Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files.',
        },
        replace_all: {
          type: 'boolean',
          description: 'Set true only when every occurrence of old_string should be replaced.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute({ toolCall }): Promise<ToolResult> {
      const text = (value: string): ToolResult => ({
        content: [{ type: 'text' as const, text: value }],
      });
      const errorText = (value: string): ToolResult => ({
        content: [{ type: 'text' as const, text: value }],
        isError: true,
      });
      const parsed = parseEditArguments(toolCall.arguments);
      if (parsed.parseError !== undefined) {
        return errorText(parsed.parseError);
      }
      const args = parsed.args;
      if (args.old_string === args.new_string) {
        return errorText('No changes to make: old_string and new_string are exactly the same.');
      }
      await host.environment.ready;
      let path: string;
      try {
        path = resolvePathAccessPath(args.path, {
          env: host.environment,
          workspace: { workspaceDir: props.workDir, additionalDirs: [] },
          operation: 'write',
        });
      } catch (error) {
        if (error instanceof PathSecurityError) {
          return errorText(error.message);
        }
        throw error;
      }
      const result = await editFile({
        path,
        displayPath: args.path,
        old_string: args.old_string,
        new_string: args.new_string,
        replace_all: args.replace_all,
      });
      if (!result.ok) {
        return errorText(result.error);
      }
      const word = result.count === 1 ? 'occurrence' : 'occurrences';
      return text(`Replaced ${String(result.count)} ${word} in ${args.path}`);
    },
  };
}
