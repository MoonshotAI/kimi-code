export interface AuthPrincipal {
  readonly userId: string;
  readonly displayName: string;
}

export const LEGACY_AUTH_PRINCIPAL: AuthPrincipal = {
  userId: 'local-server',
  displayName: 'Local server',
};
