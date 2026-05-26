import type { ToolInputDisplay } from '../../../tools/display';
import {
  DEFAULT_WORKSPACE_ACCESS_POLICY,
  resolvePathAccess,
  type PathAccessOperation,
} from '../../../tools/policies/path-access';
import type { PermissionPolicy } from '../policy';

type FileInputDisplayOperation = Extract<ToolInputDisplay, { kind: 'file_io' }>['operation'];

const FILE_ACCESS_TOOLS: Readonly<
  Record<string, readonly [PathAccessOperation, FileInputDisplayOperation]>
> = {
  Read: ['read', 'read'],
  ReadMediaFile: ['read', 'read'],
  Write: ['write', 'write'],
  Edit: ['write', 'edit'],
  Grep: ['search', 'grep'],
};

export const YoloOutsideWorkspacePermissionPolicy: PermissionPolicy = {
  name: 'yolo.outside-workspace',
  evaluate({ agent, mode, toolCallContext }) {
    if (mode !== 'yolo') return undefined;

    const toolName = toolCallContext.toolCall.name;
    const toolAccess = FILE_ACCESS_TOOLS[toolName];
    if (toolAccess === undefined) return undefined;
    const [operation, displayOperation] = toolAccess;

    const rawPath = readStringField(toolCallContext.args, 'path');
    if (rawPath === undefined) return undefined;

    let access;
    try {
      access = resolvePathAccess(
        rawPath,
        agent.config.cwd,
        {
          workspaceDir: agent.config.cwd,
          additionalDirs: agent.skills?.registry.getSkillRoots() ?? [],
        },
        {
          operation,
          pathClass: agent.runtime.kaos.pathClass(),
          homeDir: agent.runtime.kaos.gethome(),
          policy: {
            ...DEFAULT_WORKSPACE_ACCESS_POLICY,
            checkSensitive: toolName !== 'Grep',
          },
        },
      );
    } catch {
      return undefined;
    }

    if (!access.outsideWorkspace) return undefined;
    return {
      kind: 'ask',
      display: {
        kind: 'file_io',
        operation: displayOperation,
        path: access.path,
        detail: `Outside workspace: ${agent.config.cwd}`,
      },
    };
  },
};

function readStringField(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
