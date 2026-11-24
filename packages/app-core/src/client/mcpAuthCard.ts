import type { ToolCallItem } from '../conversation/types';
import type { McpAuthCard } from './types';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMcpAuthorizationUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}

export function mcpAuthCardOf(item: ToolCallItem): McpAuthCard | undefined {
  const display = item.display;
  if (!record(display) || display.kind !== 'generic' || !record(display.detail) || display.detail.kind !== 'mcp_oauth') return undefined;
  const { serverName } = display.detail;
  if (typeof serverName !== 'string' || !serverName || !item.name.startsWith('mcp__')) return undefined;
  if (item.status === 'ended') {
    if (item.outcome === 'completed') return { serverName, phase: 'connected' };
    if (item.outcome === 'interrupted' || item.note === 'mcp.oauth.cancelled') return { serverName, phase: 'cancelled' };
    if (item.note === 'mcp.oauth.reconnect_failed') return { serverName, phase: 'reconnectFailed' };
    if (item.note === 'mcp.oauth.expired') return { serverName, phase: 'expired' };
    return { serverName, phase: 'failed' };
  }
  if (item.stage === 'awaiting_approval') return { serverName, phase: 'approval' };
  if (item.stage !== 'executing') return undefined;
  if (item.fields?.['mcp.oauth.reconnecting'] === true) return { serverName, phase: 'reconnecting' };
  const request = item.fields?.['mcp.oauth.authorization_url'];
  if (request === undefined) return { serverName, phase: 'preparing' };
  if (!record(request) || request.serverName !== serverName) return { serverName, phase: 'unavailable' };
  const { waitId, authorizationUrl, expiresAt } = request;
  if (typeof waitId !== 'string' || !waitId || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) ||
      typeof authorizationUrl !== 'string' || !isMcpAuthorizationUrl(authorizationUrl)) return { serverName, phase: 'unavailable' };
  return { serverName, phase: 'waiting', request: { serverName, waitId, authorizationUrl, expiresAt } };
}
