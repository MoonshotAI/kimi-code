import {
  MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE,
  type McpOAuthAuthorizationUrlUpdateData,
  type ToolProgressEvent,
  type ToolUpdate,
} from '@moonshot-ai/kimi-code-sdk';

export type OpenUrl = (url: string) => void;

export class McpOAuthAuthorizationUrlOpener {
  private readonly openedAuthorizationUrls = new Set<string>();

  constructor(private readonly openUrl: OpenUrl) {}

  handleToolProgress(event: Pick<ToolProgressEvent, 'toolCallId' | 'update'>): void {
    const update = parseMcpOAuthAuthorizationUrlUpdate(event.update);
    if (update === undefined) return;
    const key = `${event.toolCallId}\0${update.authorizationUrl}`;
    if (this.openedAuthorizationUrls.has(key)) return;
    this.openedAuthorizationUrls.add(key);
    this.openUrl(update.authorizationUrl);
  }
}

export function parseMcpOAuthAuthorizationUrlUpdate(
  update: ToolUpdate,
): McpOAuthAuthorizationUrlUpdateData | undefined {
  if (update.kind !== 'custom') return undefined;
  if (update.customKind !== MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE) return undefined;
  const data = update.customData;
  if (!isRecord(data)) return undefined;
  const serverName = data['serverName'];
  const authorizationUrl = data['authorizationUrl'];
  if (typeof serverName !== 'string' || serverName.length === 0) return undefined;
  if (typeof authorizationUrl !== 'string' || authorizationUrl.length === 0) return undefined;
  if (!isHttpUrl(authorizationUrl)) return undefined;
  return { serverName, authorizationUrl };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
