import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IOAuthService } from '#/auth/auth';

import { OAuthService } from '#/auth/authService';
import { registerConfigServices } from '../config/stubs';
import { registerEnvironmentServices } from '../environment/stubs';
import { registerTelemetryServices } from '../telemetry/stubs';

describe('OAuthService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [
        registerConfigServices,
        registerEnvironmentServices,
        registerTelemetryServices,
      ],
      additionalServices: (reg) => {
        reg.define(IOAuthService, OAuthService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('login / status / logout', async () => {
    const svc = ix.get(IOAuthService);
    expect(await svc.status()).toEqual({ loggedIn: false });
    await svc.login('kimi');
    expect(await svc.status()).toEqual({ loggedIn: true, provider: 'kimi' });
    await svc.logout('kimi');
    expect(await svc.status()).toEqual({ loggedIn: false });
  });
});
