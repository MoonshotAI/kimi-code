import { describe, expect, it } from 'vitest';

import { OAuthService } from '#/auth/authService';

describe('OAuthService', () => {
  it('login / status / logout', async () => {
    const svc = new OAuthService(undefined as never, undefined as never, undefined as never);
    expect(await svc.status()).toEqual({ loggedIn: false });
    await svc.login('kimi');
    expect(await svc.status()).toEqual({ loggedIn: true, provider: 'kimi' });
    await svc.logout('kimi');
    expect(await svc.status()).toEqual({ loggedIn: false });
  });
});
