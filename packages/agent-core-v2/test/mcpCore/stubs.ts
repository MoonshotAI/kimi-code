import {
  fakeMcpServer,
  startFakeMcpHttpServer,
  type FakeMcpExit,
  type FakeMcpHttpServer,
  type FakeMcpHttpServerOptions,
  type FakeMcpProcessTool,
  type FakeMcpServerOptions,
} from '@moonshot-ai/testkit/fixtures';

import type { ToolDescription as KosongTool } from '#human/message';
import type { McpOAuthStore } from '#/mcpCore/oauth/store';
import type {
  McpOAuthScheduledTask,
  McpOAuthScheduler,
} from '#/mcpCore/oauth/service';
import type { MCPClient, MCPToolDefinition } from '#/mcpCore/types';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

export const UNREACHABLE_SERVER_ORIGIN = 'https://127.0.0.1:9';

export interface StdioServerCommand {
  readonly command: string;
  readonly args: string[];
}

type ServerLifecycle = Omit<FakeMcpServerOptions, 'tools'>;

const TEXT_INPUT = { properties: { text: { type: 'string' } }, required: ['text'] };

const ECHO: FakeMcpProcessTool = {
  name: 'echo',
  description: 'Echoes input text',
  inputSchema: TEXT_INPUT,
  reply: { text: { argument: 'text' } },
};

const MOCK_STDIO_TOOLS: readonly FakeMcpProcessTool[] = [
  ECHO,
  { name: 'boom', description: 'Always returns an error result', reply: { text: 'boom!', isError: true } },
  {
    name: 'read_env',
    description: 'Returns the value of process.env[name], or empty string',
    inputSchema: { properties: { name: { type: 'string' } }, required: ['name'] },
    reply: { text: { envNamedBy: 'name' } },
  },
  { name: 'whoami', description: 'Returns the client name announced during initialize', reply: { text: { clientName: true } } },
];

const STRUCTURED_ROWS = { rows: [{ id: 1 }], total: 1 };

const STRUCTURED_CONTENT_TOOLS: readonly FakeMcpProcessTool[] = [
  {
    name: 'dual_emit',
    description: 'Returns the same JSON as a text block (pretty-printed, different key order) and as structuredContent',
    reply: { text: '{\n  "total": 1,\n  "rows": [ { "id": 1 } ]\n}', structuredContent: STRUCTURED_ROWS },
  },
  {
    name: 'structured_only',
    description: 'Returns structuredContent without any text content',
    reply: { structuredContent: STRUCTURED_ROWS },
  },
  {
    name: 'prose_plus_structured',
    description: 'Returns a prose summary in content plus distinct structuredContent',
    reply: { text: 'Found 1 row.', structuredContent: STRUCTURED_ROWS },
  },
  {
    name: 'meta_vendor',
    description: 'Returns text content plus a vendor-namespaced _meta key',
    reply: { text: 'done', meta: { 'example.com/trace': 'abc123' } },
  },
  {
    name: 'faithful_rendering',
    description: 'content is a faithful human rendering of structuredContent at similar size',
    reply: {
      text: 'Project: Example Project [example-project]\nDescription: none\nTimeline: 1920x1080 @ 30fps | durationInFrames=0\nAssets: total=0',
      structuredContent: {
        project: { id: 'example-project', name: 'Example Project', description: null },
        timeline: { width: 1920, height: 1080, fps: 30, durationInFrames: 0 },
        assets: { total: 0 },
      },
    },
  },
];

function stdioServer(name: string, options: FakeMcpServerOptions): StdioServerCommand {
  const entry = fakeMcpServer(name, options);
  return { command: entry.command, args: [...entry.args] };
}

export function mockStdioServer(lifecycle: ServerLifecycle = {}): StdioServerCommand {
  return stdioServer('mock-stdio', { tools: MOCK_STDIO_TOOLS, ...lifecycle });
}

export function cwdStdioServer(name = 'cwd-stdio', lifecycle: ServerLifecycle = {}): StdioServerCommand {
  return stdioServer(name, {
    tools: [{ name: 'get_cwd', description: 'Returns the server process cwd', reply: { text: { cwd: true } } }],
    ...lifecycle,
  });
}

export function slowStdioServer(startDelayMs = 2000): StdioServerCommand {
  return stdioServer('slow-stdio', { tools: [ECHO], startDelayMs });
}

export function slowToolStdioServer(delayMs = 2000): StdioServerCommand {
  return stdioServer('slow-tool-stdio', {
    tools: [{ ...ECHO, name: 'slow_echo', description: 'Echoes input text after a delay', delayMs }],
  });
}

export function hangingListStdioServer(): StdioServerCommand {
  return stdioServer('hanging-list-stdio', { tools: [], hangListTools: true });
}

export function crashAfterConnectServer(exit: FakeMcpExit & { readonly afterMs?: number } = {}): StdioServerCommand {
  const { afterMs, ...status } = exit;
  return stdioServer('crash-after-connect', {
    tools: [ECHO, { name: 'exit_after_reply', description: 'Replies, then exits the process', reply: 'bye', exitAfterReply: status }],
    ...(afterMs === undefined ? {} : { exitAfterConnect: { ...status, afterMs } }),
  });
}

export function stderrThenExitServer(stderr = 'fatal: missing API token'): StdioServerCommand {
  return stdioServer('stderr-then-exit', { tools: [], exitBeforeConnect: { code: 2, stderr } });
}

export function structuredContentStdioServer(): StdioServerCommand {
  return stdioServer('mock-structured-content', { tools: STRUCTURED_CONTENT_TOOLS });
}

export function createMemoryMcpOAuthStore(): McpOAuthStore {
  const data = new Map<string, unknown>();
  return {
    async read<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async write(key: string, value: unknown): Promise<void> {
      data.set(key, structuredClone(value));
    },
    async remove(key: string): Promise<void> {
      data.delete(key);
    },
    async list(prefix?: string): Promise<readonly string[]> {
      const keys = [...data.keys()];
      return prefix === undefined ? keys : keys.filter((key) => key.startsWith(prefix));
    },
  };
}

export class ManualMcpOAuthScheduler implements McpOAuthScheduler {
  private current: number;
  private sequence = 0;
  private readonly tasks = new Map<
    number,
    { readonly due: number; readonly task: () => void | Promise<void> }
  >();

  constructor(now = Date.now()) {
    this.current = now;
  }

  now(): number {
    return this.current;
  }

  schedule(delayMs: number, task: () => void | Promise<void>): McpOAuthScheduledTask {
    const id = this.sequence++;
    this.tasks.set(id, { due: this.current + delayMs, task });
    return { cancel: () => this.tasks.delete(id) };
  }

  async advanceBy(deltaMs: number): Promise<void> {
    this.current += deltaMs;
    while (true) {
      const next = [...this.tasks]
        .filter(([, task]) => task.due <= this.current)
        .toSorted((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (next === undefined) return;
      this.tasks.delete(next[0]);
      await next[1].task();
    }
  }
}

export function fakeMcpClient(
  tools: readonly MCPToolDefinition[] = [
    {
      name: 'echo',
      description: 'Echoes back',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'noop',
      description: 'Does nothing',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
): MCPClient {
  return {
    async listTools() {
      return [...tools];
    },
    async callTool(name, args) {
      if (name === 'echo') {
        return { content: [{ type: 'text', text: String(args['text']) }], isError: false };
      }
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    },
    async ping() {},
  };
}

export async function discoverTools(client: MCPClient): Promise<KosongTool[]> {
  const defs = await client.listTools();
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.inputSchema as Record<string, unknown>,
  }));
}

export type TestExecutableToolContext<Input> = ExecutableToolContext & {
  readonly args: Input;
};

export async function executeTool<Input>(
  tool: ExecutableTool<Input>,
  context: TestExecutableToolContext<Input>,
): Promise<ExecutableToolResult> {
  const { args, ...executionContext } = context;
  const resolved = tool.resolveExecution(args);
  const execution: ToolExecution = isPromiseLike(resolved) ? await resolved : resolved;
  if (execution.isError === true) return execution;
  return execution.execute(executionContext);
}

const HTTP_ECHO = { ...ECHO, description: 'Echoes text' };

export function startEchoHttpMcpServer(options: Omit<FakeMcpHttpServerOptions, 'tools'> = {}): Promise<FakeMcpHttpServer> {
  return startFakeMcpHttpServer({ name: 'mock-http', tools: [HTTP_ECHO], ...options });
}

export function startAnonymousDiscoveryHttpMcpServer(opts?: {
  tokenEndpoint?: 'invalid_grant';
}): Promise<FakeMcpHttpServer> {
  return startEchoHttpMcpServer({
    name: 'mock-http-anon-discovery',
    intercept: (request) => {
      if (opts?.tokenEndpoint === 'invalid_grant' && request.method === 'POST' && request.path === '/token') {
        return { status: 400, json: { error: 'invalid_grant' } };
      }
      if (!request.rpcMethods.includes('tools/call')) return undefined;
      return {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="mcp", resource_metadata="http://x/.well-known/oauth-protected-resource"' },
        json: { error: 'unauthorized' },
      };
    },
  });
}

function isPromiseLike(
  value: ToolExecution | Promise<ToolExecution>,
): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}
