export type OAuthStorageBackend = 'file';

export interface TokenInfo {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly scope: string;
  readonly tokenType: string;
  readonly expiresIn: number;
}

export interface DeviceAuthorization {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number | null;
  readonly interval: number;
}

export interface OAuthFlowConfig {
  readonly name: string;
  readonly oauthHost: string;
  readonly clientId: string;
}

export type DeviceHeaders = {
  readonly 'X-Msh-Platform': string;
  readonly 'X-Msh-Version': string;
  readonly 'X-Msh-Device-Name': string;
  readonly 'X-Msh-Device-Model': string;
  readonly 'X-Msh-Os-Version': string;
  readonly 'X-Msh-Device-Id': string;
};

export type OAuthRequestHeaders = Record<string, string>;

export interface TokenInfoWire {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly scope: string;
  readonly token_type: string;
  readonly expires_in: number;
}

export function tokenToWire(token: TokenInfo): TokenInfoWire {
  return {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    scope: token.scope,
    token_type: token.tokenType,
    expires_in: token.expiresIn,
  };
}

export function tokenFromWire(wire: Partial<TokenInfoWire>): TokenInfo {
  return {
    accessToken: wire.access_token ?? '',
    refreshToken: wire.refresh_token ?? '',
    expiresAt: typeof wire.expires_at === 'number' ? wire.expires_at : 0,
    scope: wire.scope ?? '',
    tokenType: wire.token_type ?? '',
    expiresIn: typeof wire.expires_in === 'number' ? wire.expires_in : 0,
  };
}
