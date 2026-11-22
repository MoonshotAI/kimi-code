import { mergeKimiConfig, writeKimiConfig, type KimiConfig } from '#/fixtures/config';
import { testEnv } from '#/fixtures/env';
import { createTestHome, type TestHome } from '#/fixtures/home';
import { KapClient } from '#/kap/client';
import type { KapFrame } from '#/kap/frames';
import type { FakeModel } from '#/model/fake-model';
import { fakeModelConfig, type FakeProviderOptions } from '#/model/provider-config';

export interface KapHostIdentity {
  readonly productName: string;
  readonly version: string;
  readonly platform: string;
}

export interface KapAuthTokenService {
  readonly _serviceBrand: undefined;
  getToken(): string;
  isValid(candidate: string): Promise<boolean>;
}

export interface KapLaunchOptions {
  readonly hostIdentity: KapHostIdentity;
  readonly host?: string;
  readonly port?: number;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logLevel?: string;
  readonly logger?: unknown;
  readonly skipInstanceRegistry?: boolean;
  readonly authTokenService?: KapAuthTokenService;
}

export interface KapRunningServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartKapOptions<O extends KapLaunchOptions, S extends KapRunningServer> {
  readonly startServer: (options: O) => Promise<S>;
  readonly model?: FakeModel;
  readonly provider?: FakeProviderOptions;
  readonly config?: KimiConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly serverOptions?: Partial<O>;
  readonly home?: TestHome;
  readonly isolateHome?: boolean;
  readonly onFrame?: (frame: KapFrame) => void;
  readonly token?: string;
}

export const TESTKIT_HOST_IDENTITY: KapHostIdentity = { productName: 'testkit', version: '0.0.0-test', platform: 'testkit' };

const BASE_CONFIG: KimiConfig = {
  extra: { model_catalog: { refresh_on_start: false, refresh_interval_ms: 0 } },
};

export class KapHarness<S extends KapRunningServer = KapRunningServer> extends KapClient {
  readonly home: TestHome;
  private readonly options: StartKapOptions<KapLaunchOptions, S>;
  private readonly ownsHome: boolean;
  private readonly state: { server: S };
  private restoreHome: (() => void) | undefined;
  private closed = false;

  private constructor(
    options: StartKapOptions<KapLaunchOptions, S>,
    home: TestHome,
    ownsHome: boolean,
    token: string,
    server: S,
    restoreHome: (() => void) | undefined,
  ) {
    const state = { server };
    super({ origin: () => `http://127.0.0.1:${state.server.port}`, token: () => token }, { workspace: home.workspace, onFrame: options.onFrame });
    this.options = options;
    this.home = home;
    this.ownsHome = ownsHome;
    this.state = state;
    this.restoreHome = restoreHome;
  }

  static async start<O extends KapLaunchOptions, S extends KapRunningServer>(options: StartKapOptions<O, S>): Promise<KapHarness<S>> {
    const home = options.home ?? (await createTestHome('testkit-kap'));
    const token = options.token ?? `testkit-${Math.random().toString(36).slice(2)}`;
    if (options.model !== undefined) await options.model.listen();
    const config = [BASE_CONFIG, options.model === undefined ? {} : fakeModelConfig(options.model, options.provider), options.config ?? {}].reduce(
      (merged, next) => mergeKimiConfig(merged, next),
    );
    await writeKimiConfig(home.dataDir, config);
    const restoreHome = options.isolateHome === false ? undefined : pointHomeAt(home.home);
    const generic = options as unknown as StartKapOptions<KapLaunchOptions, S>;
    try {
      const server = await launch(generic, home, token);
      return new KapHarness(generic, home, options.home === undefined, token, server, restoreHome);
    } catch (error) {
      restoreHome?.();
      if (options.home === undefined) await home.remove();
      throw error;
    }
  }

  get server(): S {
    return this.state.server;
  }

  async restart(): Promise<void> {
    await this.closeSockets();
    await this.state.server.close();
    this.state.server = await launch(this.options, this.home, this.token);
  }

  async writeConfig(config: KimiConfig): Promise<void> {
    await writeKimiConfig(this.home.dataDir, config);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.closeSockets();
      await this.state.server.close();
    } finally {
      this.restoreHome?.();
      this.restoreHome = undefined;
      if (this.ownsHome) await this.home.remove();
    }
  }
}

export function startKap<O extends KapLaunchOptions, S extends KapRunningServer>(options: StartKapOptions<O, S>): Promise<KapHarness<S>> {
  return KapHarness.start(options);
}

function launch<S extends KapRunningServer>(options: StartKapOptions<KapLaunchOptions, S>, home: TestHome, token: string): Promise<S> {
  const authTokenService: KapAuthTokenService = {
    _serviceBrand: undefined,
    getToken: () => token,
    isValid: (candidate) => Promise.resolve(candidate === token),
  };
  return options.startServer({
    hostIdentity: TESTKIT_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home.dataDir,
    env: testEnv({ set: { HOME: home.home, ...options.env } }),
    logLevel: 'silent',
    skipInstanceRegistry: true,
    authTokenService,
    ...options.serverOptions,
  });
}

interface HomeOverride {
  readonly home: string;
}

const homeOverrides: HomeOverride[] = [];
let homeBeforeOverrides: Readonly<Record<'HOME' | 'USERPROFILE', string | undefined>> | undefined;

function pointHomeAt(home: string): () => void {
  if (homeOverrides.length === 0) homeBeforeOverrides = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
  const override: HomeOverride = { home };
  homeOverrides.push(override);
  applyHome(home);
  return () => {
    const index = homeOverrides.indexOf(override);
    if (index === -1) return;
    homeOverrides.splice(index, 1);
    const current = homeOverrides.at(-1);
    if (current !== undefined) {
      applyHome(current.home);
      return;
    }
    for (const [key, value] of Object.entries(homeBeforeOverrides ?? {})) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    homeBeforeOverrides = undefined;
  };
}

function applyHome(home: string): void {
  process.env['HOME'] = home;
  if (process.platform === 'win32') process.env['USERPROFILE'] = home;
}
