/**
 * Scenario: the MCP client factory declares the channel capability and
 * delivers `notifications/kimi/channel` end-to-end over a real SDK
 * Client/Server pair (no stdio process — `InMemoryTransport` links them
 * directly in-process).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { KIMI_CHANNEL_NOTIFICATION_METHOD } from '#/agent/mcp/channel-notification';
import { createMcpSdkClient } from '#/agent/mcp/client-shared';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createMcpSdkClient', () => {
  it('declares the channel experimental capability and delivers a channel notification', async () => {
    const { client, channelHub } = createMcpSdkClient('kimi-code-test', '0.0.0');
    const server = new Server({ name: 'test-server', version: '0.0.0' }, { capabilities: {} });
    const received: Array<{ text: string; chatId?: string }> = [];
    channelHub.onChannelMessage((message) => received.push(message));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    expect(server.getClientCapabilities()?.experimental).toEqual({ channel: {} });

    await server.notification({
      method: KIMI_CHANNEL_NOTIFICATION_METHOD,
      params: { text: 'hello', chatId: 'chat-1' },
    });
    await flush();

    expect(received).toEqual([{ text: 'hello', chatId: 'chat-1' }]);

    await client.close();
    await server.close();
  });

  it('buffers a channel message that arrives before a listener is attached', async () => {
    const { client, channelHub } = createMcpSdkClient('kimi-code-test', '0.0.0');
    const server = new Server({ name: 'test-server', version: '0.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await server.notification({
      method: KIMI_CHANNEL_NOTIFICATION_METHOD,
      params: { text: 'early' },
    });
    await flush();

    const received: Array<{ text: string; chatId?: string }> = [];
    channelHub.onChannelMessage((message) => received.push(message));
    expect(received).toEqual([{ text: 'early', chatId: undefined }]);

    await client.close();
    await server.close();
  });
});
