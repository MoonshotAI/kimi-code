/**
 * Scenario: MCP channel notifications get routed into the main agent's
 * prompt queue with a distinct, non-user origin.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/session/mcp/sessionMcpChannelBridge.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/_base/di/scope';
import { Event } from '#/_base/event';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { McpChannelMessage } from '#/agent/mcp/connection-manager';
import type { IAgentPromptService } from '#/agent/prompt/prompt';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { SessionMcpChannelBridgeImpl } from '#/session/mcp/sessionMcpChannelBridgeImpl';
import type { ISessionMcpService } from '#/session/mcp/sessionMcp';

function harness() {
  let channelListener: ((message: McpChannelMessage) => void) | undefined;
  const unsubscribe = vi.fn();
  const sessionMcp = {
    ensureMcpReady: vi.fn(),
    connectionManager: () => ({
      onChannelMessage: (listener: (message: McpChannelMessage) => void) => {
        channelListener = listener;
        return unsubscribe;
      },
    }),
  } as unknown as ISessionMcpService;

  const inject = vi.fn().mockResolvedValue(undefined);
  const promptService = { inject } as unknown as IAgentPromptService;
  const mainHandle: IAgentScopeHandle = {
    id: 'main',
    kind: LifecycleScope.Agent,
    accessor: { get: (() => promptService) as IAgentScopeHandle['accessor']['get'] },
    dispose: () => {},
  };

  let mainAgent: IAgentScopeHandle | undefined = mainHandle;
  const agentLifecycle = {
    get: (id: string) => (id === 'main' ? mainAgent : undefined),
    onDidCreate: Event.None,
  } as unknown as IAgentLifecycleService;

  return {
    sessionMcp,
    agentLifecycle,
    inject,
    unsubscribe,
    fireChannelMessage: (message: McpChannelMessage) => channelListener?.(message),
    clearMainAgent: () => {
      mainAgent = undefined;
    },
  };
}

describe('SessionMcpChannelBridgeImpl', () => {
  it('injects a channel message into the main agent with a distinct origin', () => {
    const h = harness();
    new SessionMcpChannelBridgeImpl(h.sessionMcp, h.agentLifecycle);

    h.fireChannelMessage({ server: 'discord', text: 'hello from discord', chatId: 'chat-1' });

    expect(h.inject).toHaveBeenCalledTimes(1);
    const message = h.inject.mock.calls[0]?.[0] as ContextMessage;
    expect(message.role).toBe('user');
    expect(message.content).toEqual([{ type: 'text', text: 'hello from discord' }]);
    expect(message.origin).toEqual({ kind: 'mcp_channel', server: 'discord', chatId: 'chat-1' });
  });

  it('drops the message when there is no main agent yet', () => {
    const h = harness();
    h.clearMainAgent();
    new SessionMcpChannelBridgeImpl(h.sessionMcp, h.agentLifecycle);

    h.fireChannelMessage({ server: 'discord', text: 'hello' });

    expect(h.inject).not.toHaveBeenCalled();
  });

  it('unsubscribes from the connection manager on dispose', () => {
    const h = harness();
    const bridge = new SessionMcpChannelBridgeImpl(h.sessionMcp, h.agentLifecycle);
    bridge.dispose();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
