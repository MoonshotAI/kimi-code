import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const defaultTools = [
  {
    name: 'echo',
    description: 'Echo back the provided text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
    },
  },
  {
    name: 'image',
    description: 'Return a tiny PNG image.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'big',
    description: 'Return an oversized image payload.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'structured',
    description: 'Return structured content with meta.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'die_once',
    description: 'Crash the server on the first call, succeed afterwards.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const tools = process.env.FAKE_MCP_TOOLS
  ? JSON.parse(process.env.FAKE_MCP_TOOLS)
  : defaultTools;

if (process.env.FAKE_MCP_STDERR) {
  process.stderr.write(process.env.FAKE_MCP_STDERR);
}

function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: value })}\n`);
}

function error(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function callTool(name, args) {
  if (name === 'echo') {
    return { content: [{ type: 'text', text: typeof args?.text === 'string' ? args.text : JSON.stringify(args ?? {}) }] };
  }
  if (name === 'image') {
    return { content: [{ type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }] };
  }
  if (name === 'big') {
    return {
      content: [
        {
          type: 'image',
          data: Buffer.alloc(11 * 1024 * 1024).toString('base64'),
          mimeType: 'image/png',
        },
      ],
    };
  }
  if (name === 'structured') {
    return {
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { ok: true, extra: 'yes' },
      _meta: { 'mcp.internal/secret': 1, 'example.com/custom': 2 },
    };
  }
  if (name === 'die_once') {
    const marker = process.env.FAKE_MCP_DIE_ONCE_FILE;
    if (marker !== undefined && !existsSync(marker)) {
      writeFileSync(marker, 'died');
      process.exit(2);
    }
    return { content: [{ type: 'text', text: 'survived' }] };
  }
  return undefined;
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '0.0.1' },
    });
    return;
  }
  if (message.method === 'ping') {
    result(message.id, {});
    return;
  }
  if (message.method === 'tools/list') {
    result(message.id, { tools });
    return;
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const value = callTool(name, message.params?.arguments);
    if (value === undefined) {
      error(message.id, -32601, `unknown tool: ${String(name)}`);
      return;
    }
    result(message.id, value);
    return;
  }
  error(message.id, -32601, `unknown method: ${String(message.method)}`);
});
