import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'channel-stdio', version: '0.0.1' });

server.registerTool('noop', { description: 'noop', inputSchema: {} }, () => ({ content: [] }));

// Send once the client's post-initialize handshake completes, so the
// notification can't race the client's own `initialize` request.
server.server.oninitialized = () => {
  void server.server.notification({
    method: 'notifications/kimi/channel',
    params: { text: 'New Discord message', chatId: 'chat-1' },
  });
};

await server.connect(new StdioServerTransport());
