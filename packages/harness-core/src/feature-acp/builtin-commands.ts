import type { AvailableCommand } from '@agentclientprotocol/sdk';

import type { CompactionFace } from '#/features/compaction/index';
import { CompactError } from '#/features/compaction/index';
import type { McpFacade, McpServerEntry } from '#/features/mcp/index';
import type { TaskFace } from '#/features/task/index';
import type { UsageFace } from '#/features/usage/index';

export const ACP_BUILTIN_SLASH_COMMANDS = [
  {
    name: 'compact',
    description: 'Compact the conversation context',
    input: { hint: '<optional custom summarization instructions>' },
  },
  {
    name: 'status',
    description: 'Show current session status',
  },
  {
    name: 'usage',
    description: 'Show session token usage',
  },
  {
    name: 'mcp',
    description: 'Show MCP server status',
  },
  {
    name: 'tasks',
    description: 'List background tasks',
  },
] as const satisfies readonly AvailableCommand[];

export type AcpBuiltinSlashCommandName = (typeof ACP_BUILTIN_SLASH_COMMANDS)[number]['name'];

export const ACP_BUILTIN_SLASH_COMMAND_NAMES = new Set<string>(
  ACP_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
);

export function isAcpBuiltinSlashCommand(name: string): name is AcpBuiltinSlashCommandName {
  return ACP_BUILTIN_SLASH_COMMAND_NAMES.has(name);
}

export interface AcpBuiltinCommandDeps {
  readonly sessionId: string;
  readonly modelId: string;
  readonly thinkingLevel: string;
  readonly modeId: string;
  readonly cwd?: string | undefined;
  readonly title?: string | undefined;
  readonly usage?: UsageFace | undefined;
  readonly tasks?: TaskFace | undefined;
  readonly compaction?: CompactionFace | undefined;
  readonly mcp?: McpFacade | undefined;
}

export function availableBuiltinCommands(deps: AcpBuiltinCommandDeps): AvailableCommand[] {
  return ACP_BUILTIN_SLASH_COMMANDS.filter(
    (command) =>
      (command.name !== 'compact' || deps.compaction !== undefined) &&
      (command.name !== 'mcp' || deps.mcp !== undefined),
  ).map((command) => ({ ...command }));
}

export async function runBuiltinSlashCommand(
  name: AcpBuiltinSlashCommandName,
  deps: AcpBuiltinCommandDeps,
  args = '',
): Promise<string> {
  switch (name) {
    case 'status':
      return statusText(deps);
    case 'usage':
      return usageText(deps.usage);
    case 'tasks':
      return tasksText(deps.tasks);
    case 'mcp': {
      if (deps.mcp === undefined) {
        return '/mcp failed: MCP is unavailable';
      }
      return mcpText(deps.mcp.list());
    }
    case 'compact': {
      if (deps.compaction === undefined) {
        return '/compact failed: compaction is unavailable';
      }
      try {
        await deps.compaction.compact(args === '' ? undefined : args);
        return 'Context compaction started — it runs in the background and the compacted context applies once it finishes.';
      } catch (error) {
        if (error instanceof CompactError && error.code === 'busy') {
          return 'A context compaction is already running.';
        }
        throw error;
      }
    }
  }
}

function statusText(deps: AcpBuiltinCommandDeps): string {
  const lines = [
    `Session: ${deps.sessionId}`,
    `Model: ${deps.modelId === '' ? '(unbound)' : deps.modelId} (thinking: ${deps.thinkingLevel})`,
    `Mode: ${deps.modeId}`,
    `Working directory: ${deps.cwd ?? '(unknown)'}`,
  ];
  if (deps.title !== undefined && deps.title !== '') {
    lines.splice(1, 0, `Title: ${deps.title}`);
  }
  return lines.join('\n');
}

function usageText(usage: UsageFace | undefined): string {
  const records = usage?.records.value ?? [];
  const last = records.at(-1);
  const lastTotal =
    last === undefined
      ? 0
      : (last.usage.inputOther ?? 0) +
        (last.usage.inputCacheRead ?? 0) +
        (last.usage.inputCacheCreation ?? 0) +
        (last.usage.output ?? 0);
  const lines = [`Context: ${lastTotal} tokens`];
  const total = usage?.summary.value.total;
  if (total === undefined || records.length === 0) {
    lines.push('Session total: no LLM calls yet');
  } else {
    const input = total.inputOther + total.inputCacheRead + total.inputCacheCreation;
    lines.push(`Session total: ${input} input, ${total.output} output`);
  }
  return lines.join('\n');
}

function tasksText(tasks: TaskFace | undefined): string {
  const active = [...(tasks?.records.value.values() ?? [])].filter(
    (record) => record.status === 'running',
  );
  if (active.length === 0) return 'No background tasks.';
  const lines = active.map(
    (record) => `- ${record.taskId}: ${record.description ?? record.toolName} (${record.status})`,
  );
  return [`Background tasks (${active.length}):`, ...lines].join('\n');
}

function mcpText(servers: readonly McpServerEntry[]): string {
  if (servers.length === 0) return 'No MCP servers configured for this session.';
  const lines = servers.map((server) => {
    const line = `- ${server.name} (${server.transport}): ${server.status}, ${server.toolCount} tools`;
    return server.error !== undefined && server.error !== '' ? `${line} — ${server.error}` : line;
  });
  return [`MCP servers (${servers.length}):`, ...lines].join('\n');
}
