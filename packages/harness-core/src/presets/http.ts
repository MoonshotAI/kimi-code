import { createFeature } from '#/app/index';
import { useInject, type ShallowRef } from '#/composition-api/index';
import { createHttp, HttpRef, type CreateHttpOptions, type Http } from '#/feature-http/index';
import { isHostCheckDisabled, parseAllowedHosts } from '#/feature-http/security/hostnames';
import {
  detectOpenInApps,
  type OpenInAppId,
  type OsHost,
} from '#/todo-features/os/index';

import { createDefaultApp, type CreateDefaultAppOptions, type DefaultApp } from './base';
import { createDefaultRemoteControl } from './remote-control';

export type CreateDefaultHttpOptions = CreateDefaultAppOptions & CreateHttpOptions;

export function createDefaultHttp(options: CreateDefaultHttpOptions = {}): DefaultApp {
  const base = createDefaultApp(options);
  const env = options.env ?? process.env;
  base.app.features.add(
    createHttp({
      ...options,
      HOME: options.HOME ?? base.home,
      PASSWORD: options.PASSWORD ?? env['KIMI_CODE_PASSWORD'],
      ALLOWED_HOSTS: [...parseAllowedHosts(env), ...(options.ALLOWED_HOSTS ?? [])],
      DISABLE_HOST_CHECK: options.DISABLE_HOST_CHECK ?? isHostCheckDisabled(env),
      PLUGIN_MARKETPLACE_URL:
        options.PLUGIN_MARKETPLACE_URL ?? env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'],
      openInApps: options.openInApps ?? cachedOpenInApps(base.host),
    }),
  );
  const bridge: { http?: Readonly<ShallowRef<Http | undefined>> } = {};
  base.app.features.add(
    createFeature('defaults-http-bridge', {
      app() {
        bridge.http = useInject(HttpRef);
      },
    }),
  );
  base.app.features.add(
    createDefaultRemoteControl({
      env,
      homeDir: base.home,
      localOrigin: () => bridge.http?.value?.origin ?? '',
      localServerToken: () => bridge.http?.value?.authTokenService?.getToken?.() ?? '',
      clientVersion: `kimi-code/${options.version ?? '0.0.0'}`,
      urlSource: process.platform,
    }),
  );
  return base;
}

function cachedOpenInApps(host: OsHost): () => Promise<readonly OpenInAppId[]> {
  let cached: Promise<readonly OpenInAppId[]> | undefined;
  return () => {
    cached ??= detectOpenInApps(host);
    return cached;
  };
}
