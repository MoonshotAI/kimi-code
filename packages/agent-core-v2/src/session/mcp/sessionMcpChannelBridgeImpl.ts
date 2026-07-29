/**
 * `mcp` domain (L5) — `ISessionMcpChannelBridge` implementation.
 *
 * Subscribes to the session's `McpConnectionManager.onChannelMessage` and,
 * for each message, injects it into the session's main agent through
 * `IAgentPromptService.inject()` — the same cross-scope pattern
 * `SessionCronServiceImpl` uses to steer cron fires into the main agent.
 * Tags the injected message with `McpChannelOrigin` rather than
 * `USER_PROMPT_ORIGIN`, since the content originates from an external,
 * possibly-untrusted channel, not the CLI operator. A message that arrives
 * before the main agent exists (or after the session is disposed) is
 * silently dropped — there is no queue to replay it from once the MCP
 * server's own delivery/backlog semantics (e.g. Discord history) are gone.
 * Bound at Session scope.
 */

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { McpChannelMessage } from '#/agent/mcp/connection-manager';
import type { ContextMessage, McpChannelOrigin } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { ISessionMcpChannelBridge } from './sessionMcpChannelBridge';
import { ISessionMcpService } from './sessionMcp';

export class SessionMcpChannelBridgeImpl extends Disposable implements ISessionMcpChannelBridge {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionMcpService private readonly sessionMcp: ISessionMcpService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {
    super();
    this._register(
      toDisposable(
        this.sessionMcp.connectionManager().onChannelMessage((message) => {
          this.deliver(message);
        }),
      ),
    );
  }

  private deliver(message: McpChannelMessage): void {
    const mainHandle = this.agentLifecycle.get('main');
    if (mainHandle === undefined) return;

    const origin: McpChannelOrigin = { kind: 'mcp_channel', server: message.server, chatId: message.chatId };
    const contextMessage: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: message.text }],
      toolCalls: [],
      origin,
    };
    const promptService = mainHandle.accessor.get(IAgentPromptService);
    void promptService.inject(contextMessage).catch(() => {});
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMcpChannelBridge,
  SessionMcpChannelBridgeImpl,
  ScopeActivation.OnScopeCreated,
  'mcpChannelBridge',
);
