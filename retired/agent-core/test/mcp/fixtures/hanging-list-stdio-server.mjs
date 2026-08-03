// Completes the MCP initialize handshake, then leaves tools/list pending.

import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

for await (const line of lines) {
  const message = JSON.parse(line);

  if (message.method === 'initialize' && message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'hanging-list-stdio', version: '0.0.1' },
      },
    });
    continue;
  }

  if (message.method === 'tools/list') {
    continue;
  }

  if (message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Unsupported method: ${message.method}` },
    });
  }
}
