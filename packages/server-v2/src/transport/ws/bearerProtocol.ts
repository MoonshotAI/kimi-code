/**
 * WebSocket bearer-token subprotocol helpers.
 */

export const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

export function extractWsBearerToken(protocolHeader: string | undefined): string | null {
  if (protocolHeader === undefined) {
    return null;
  }
  for (const entry of protocolHeader.split(',')) {
    const protocol = entry.trim();
    if (protocol.startsWith(WS_BEARER_PROTOCOL_PREFIX)) {
      const token = protocol.slice(WS_BEARER_PROTOCOL_PREFIX.length);
      return token.length === 0 ? null : token;
    }
  }
  return null;
}

export function selectWsBearerProtocol(protocols: Iterable<string>): string | false {
  for (const protocol of protocols) {
    if (protocol.startsWith(WS_BEARER_PROTOCOL_PREFIX)) {
      return protocol;
    }
  }
  return false;
}
