/**
 * `mcp` domain (L5) — `ISessionMcpChannelBridge` implementation.
 *
 * Subscribes to the session's `McpConnectionManager.onChannelMessage` and,
 * for each message, injects it into the session's main agent through
 * `IAgentPromptService.inject()` — the same cross-scope pattern
 * `SessionCronServiceImpl` uses to steer cron fires into the main agent.
 * Gated behind the `mcp-channel` experimental flag (`mcpChannelFlag.ts`):
 * when disabled the constructor skips the subscription entirely, so the
 * bridge does nothing at all rather than merely suppressing delivery.
 * Wraps the pushed text in a `<mcp-channel>` XML envelope (escaping both the
 * attributes and the text content, unlike `renderCronFireXml`'s
 * attribute-only escaping — cron's `prompt` is operator-authored, this
 * `text` is untrusted external-channel content that must not be able to
 * break out of the envelope) and tags the injected message with
 * `McpChannelOrigin` rather than `USER_PROMPT_ORIGIN`, since the content
 * originates from an external, possibly-untrusted channel, not the CLI
 * operator. A message that arrives before the main agent exists (or after
 * the session is disposed) is silently dropped — there is no queue to
 * replay it from once the MCP server's own delivery/backlog semantics (e.g.
 * Discord history) are gone. Publishes `mcp.channel.received` on the main
 * agent's `IEventBus` after a successful inject (mirroring
 * `SessionCronServiceImpl.signalCron`'s `cron.fired`) and always logs
 * injection failures via `ILogService` (unconditionally, unlike cron's
 * config-gated `debugLog` — a push failure here is rare and worth seeing,
 * not a constant tick). Bound at Session scope.
 */

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { escapeXmlAttr, escapeXmlTags } from '#/_base/utils/xml-escape';
import type { McpChannelMessage } from '#/agent/mcp/connection-manager';
import type { ContextMessage, McpChannelOrigin } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { MCP_CHANNEL_FLAG_ID } from './mcpChannelFlag';
import { ISessionMcpChannelBridge } from './sessionMcpChannelBridge';
import { ISessionMcpService } from './sessionMcp';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'mcp.channel.received': {
      readonly server: string;
      readonly chatId?: string;
      readonly text: string;
      readonly receivedAt: string;
    };
  }
}

export class SessionMcpChannelBridgeImpl extends Disposable implements ISessionMcpChannelBridge {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionMcpService private readonly sessionMcp: ISessionMcpService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    if (!this.flags.enabled(MCP_CHANNEL_FLAG_ID)) return;

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
      content: [{ type: 'text', text: renderMcpChannelXml(origin, message.text) }],
      toolCalls: [],
      origin,
    };
    const promptService = mainHandle.accessor.get(IAgentPromptService);
    promptService.inject(contextMessage).then(
      () => {
        mainHandle.accessor.get(IEventBus).publish({
          type: 'mcp.channel.received',
          server: message.server,
          chatId: message.chatId,
          text: message.text,
          receivedAt: new Date().toISOString(),
        });
      },
      (error: unknown) => {
        this.log.error('mcp channel push injection failed', { server: message.server, error });
      },
    );
  }
}

function renderMcpChannelXml(origin: McpChannelOrigin, text: string): string {
  const server = escapeXmlAttr(origin.server);
  const chatIdAttr = origin.chatId !== undefined ? ` chatId="${escapeXmlAttr(origin.chatId)}"` : '';
  return [
    `<mcp-channel server="${server}"${chatIdAttr}>`,
    escapeXmlTags(text),
    '</mcp-channel>',
  ].join('\n');
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMcpChannelBridge,
  SessionMcpChannelBridgeImpl,
  ScopeActivation.OnScopeCreated,
  'mcpChannelBridge',
);
