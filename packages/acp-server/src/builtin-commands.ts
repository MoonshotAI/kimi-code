import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type {
  AgentHandle,
  AgentTaskInfo,
  Klient,
  McpServerEntry,
  SessionHandle,
  UsageStatus,
} from '@moonshot-ai/klient';

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
  {
    name: 'help',
    description: 'Show available ACP commands',
  },
] as const satisfies readonly AvailableCommand[];

export type AcpBuiltinSlashCommandName = (typeof ACP_BUILTIN_SLASH_COMMANDS)[number]['name'];

export const ACP_BUILTIN_SLASH_COMMAND_NAMES = new Set<string>(
  ACP_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
);

export function isAcpBuiltinSlashCommand(name: string): name is AcpBuiltinSlashCommandName {
  return ACP_BUILTIN_SLASH_COMMAND_NAMES.has(name);
}

export interface BuiltinCommandDeps {
  readonly klient: Klient;
  readonly session: SessionHandle;
  readonly agent: AgentHandle;
  readonly sessionId: string;
  readonly modelId: string;
  readonly thinkingEnabled: boolean;
  readonly modeId: string;
  readonly availableCommands: readonly AvailableCommand[];
}

export async function runBuiltinSlashCommand(
  name: AcpBuiltinSlashCommandName,
  deps: BuiltinCommandDeps,
  args = '',
): Promise<string> {
  switch (name) {
    case 'help':
      return helpText(deps.availableCommands);
    case 'status':
      return statusText(await deps.session.get(), deps);
    case 'usage':
      return usageText(
        await deps.agent.getUsage(),
        await deps.agent.getContext(),
        (await deps.klient.global.kosong.listModels()).find((item) => item.model === deps.modelId)
          ?.max_context_size,
      );
    case 'tasks':
      return tasksText(await deps.agent.getTasks({ activeOnly: true }));
    case 'mcp':
      return mcpText(await deps.agent.getMcpServers());
    case 'compact': {
      const started = await deps.agent.compact({
        instruction: args === '' ? undefined : args,
      });
      return started
        ? 'Context compaction started — it runs in the background and the compacted context applies once it finishes.'
        : 'A context compaction is already running.';
    }
  }
}

function helpText(commands: readonly AvailableCommand[]): string {
  const lines = commands.map((command) => `/${command.name} — ${command.description}`);
  return ['Available commands:', ...lines].join('\n');
}

function statusText(
  meta: { readonly title?: string; readonly cwd?: string },
  deps: BuiltinCommandDeps,
): string {
  const lines = [
    `Session: ${deps.sessionId}`,
    `Model: ${deps.modelId === '' ? '(unbound)' : deps.modelId} (thinking: ${deps.thinkingEnabled ? 'on' : 'off'})`,
    `Mode: ${deps.modeId}`,
    `Working directory: ${meta.cwd ?? '(unknown)'}`,
  ];
  if (meta.title !== undefined && meta.title !== '') {
    lines.splice(1, 0, `Title: ${meta.title}`);
  }
  return lines.join('\n');
}

function usageText(
  usage: UsageStatus,
  context: { readonly tokenCount: number },
  contextSize: number | undefined,
): string {
  const lines = [
    contextSize !== undefined
      ? `Context: ${context.tokenCount} / ${contextSize} tokens (${Math.round((context.tokenCount / contextSize) * 100)}%)`
      : `Context: ${context.tokenCount} tokens`,
  ];
  const total = usage.total;
  if (total === undefined) {
    lines.push('Session total: no LLM calls yet');
  } else {
    const input = total.inputOther + total.inputCacheRead + total.inputCacheCreation;
    lines.push(`Session total: ${input} input, ${total.output} output`);
  }
  return lines.join('\n');
}

function tasksText(tasks: readonly AgentTaskInfo[]): string {
  if (tasks.length === 0) return 'No background tasks.';
  const lines = tasks.map((task) => `- ${task.taskId}: ${task.description} (${task.status})`);
  return [`Background tasks (${tasks.length}):`, ...lines].join('\n');
}

function mcpText(servers: readonly McpServerEntry[]): string {
  if (servers.length === 0) return 'No MCP servers configured for this session.';
  const lines = servers.map((server) => {
    const line = `- ${server.name} (${server.transport}): ${server.status}, ${server.toolCount} tools`;
    return server.error !== undefined && server.error !== '' ? `${line} — ${server.error}` : line;
  });
  return [`MCP servers (${servers.length}):`, ...lines].join('\n');
}
