import type { ILogger } from '#/_base/log/log';
import type { McpConnectionManager, McpServerEntry } from '#/mcpCore/connection-manager';
import { canonicalMcpOAuthResource } from '#/mcpCore/oauth/store';
import type { McpOAuthEvent, McpOAuthService } from '#/mcpCore/oauth/service';

export function subscribeMcpOAuthEvents(
  oauthService: McpOAuthService,
  log: ILogger,
  manager: McpConnectionManager,
): () => void {
  return oauthService.onEvent((event) => {
    void handleMcpOAuthEvent(oauthService, manager, event).catch((error: unknown) => {
      log.warn(`mcp oauth event handling failed: ${String(error)}`);
    });
  });
}

async function handleMcpOAuthEvent(
  oauthService: McpOAuthService,
  manager: McpConnectionManager,
  event: McpOAuthEvent,
): Promise<void> {
  if (event.type === 'tokens-invalidated' && event.scope !== 'tokens' && event.scope !== 'all') {
    return;
  }
  const entry = manager.get(event.serverName);
  if (entry === undefined) return;
  const serverUrl = manager.getRemoteServerUrl(event.serverName);
  if (serverUrl === undefined || canonicalMcpOAuthResource(serverUrl) !== event.serverUrl) return;
  if (event.type === 'tokens-invalidated') {
    oauthService.forgetProvider(event.serverName, event.serverUrl);
    if (entry.status === 'needs-auth') return;
  }
  if (entry.status === 'disabled' || entry.status === 'removed') return;
  if (entry.status === 'pending') {
    await waitForPendingSettle(manager, event.serverName);
    return;
  }
  if (
    event.type === 'tokens-saved' &&
    entry.status !== 'needs-auth' &&
    entry.status !== 'failed'
  ) {
    return;
  }
  if (event.type === 'refresh-failed' && entry.status !== 'connected') return;
  await manager.reconnectAndJoin(event.serverName);
}

function waitForPendingSettle(manager: McpConnectionManager, serverName: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let unsubscribe = (): void => {};
    let settled = false;
    const reconnect = (next: McpServerEntry | undefined): void => {
      if (settled) return;
      if (next !== undefined && (next.name !== serverName || next.status === 'pending')) {
        return;
      }
      settled = true;
      unsubscribe();
      if (next === undefined || next.status === 'disabled' || next.status === 'removed') {
        resolve();
        return;
      }
      void manager.reconnectAfterCurrent(serverName).then(resolve, reject);
    };
    unsubscribe = manager.onStatusChange(reconnect);
    if (settled) unsubscribe();
    else reconnect(manager.get(serverName));
  });
}
