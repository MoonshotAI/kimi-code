/**
 * `oauthService` + `authSummaryService` — app-scope OAuth device flow and
 * auth summary. Host-side service group: built on
 * `@moonshot-ai/kimi-code-oauth`'s `KimiOAuthToolkit` (device-code login with
 * `onDeviceCode`, logout, token cache) plus node-sdk's public `loadRuntimeConfigSafe`
 * for config reads; config writes go through the rust-loop `configSet` bridge so
 * the engine stays the single owner of the on-disk config. Mirrors
 * `agent-core-v2/app/auth/authService.ts` (flow state machine, terminal status
 * classification, managed-provider deprovisioning); wire shapes mirror
 * `protocol/src/rest/oauth.ts`. `resolveTokenProvider` / `getCachedAccessToken`
 * are excluded (non-serializable).
 */

import { randomUUID } from 'node:crypto';

import {
  applyManagedKimiCodeLogoutConfig,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  kimiCodeBaseUrl,
  refreshProviderModels,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeOAuthRef,
  resolveKimiCodeRuntimeAuth,
  type DeviceAuthorization,
  type ManagedKimiConfigShape,
  type ManagedKimiOAuthRef,
  type RefreshProviderHost,
} from '@moonshot-ai/kimi-code-oauth';
import { loadRuntimeConfigSafe } from '@moonshot-ai/kimi-code-sdk';

import { registerService } from '../router.js';
import type { RustCallContext, RustServiceRegistry } from '../types.js';

// ── Wire shapes (mirror contract/global/auth.ts) ──────────────────────────

type OAuthFlowStatus = 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled';

interface OAuthFlowStartPending {
  flow_id: string;
  provider: string;
  status: 'pending';
  verification_uri: string;
  verification_uri_complete: string;
  user_code: string;
  expires_in: number;
  interval: number;
  expires_at: string;
}

interface OAuthFlowStartAuthenticated {
  flow_id: string;
  provider: string;
  status: 'authenticated';
}

type OAuthFlowStart = OAuthFlowStartPending | OAuthFlowStartAuthenticated;

interface OAuthFlowSnapshot extends Omit<OAuthFlowStartPending, 'status'> {
  status: OAuthFlowStatus;
  resolved_at?: string;
  error_message?: string;
}

interface OAuthLoginCancelResponse {
  cancelled: boolean;
  status: OAuthFlowStatus;
}

interface OAuthLogoutResponse {
  logged_out: true;
  provider: string;
}

interface AuthStatus {
  loggedIn: boolean;
  provider?: string;
}

interface RefreshOAuthProviderModelsResponse {
  changed: Array<{
    provider_id: string;
    provider_name: string;
    added: number;
    removed: number;
  }>;
  unchanged: string[];
  failed: Array<{ provider: string; reason: string }>;
}

// ── Constants ─────────────────────────────────────────────────────────────

const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_EXPIRES_IN_SEC = 15 * 60;

// ── Flow state (module-scoped singleton, app scope semantics) ─────────────

interface FlowState {
  readonly flowId: string;
  readonly provider: string;
  readonly controller: AbortController;
  readonly oauthRef: ManagedKimiOAuthRef | undefined;
  readonly loginBaseUrl: string | undefined;
  device: DeviceAuthorization | undefined;
  status: OAuthFlowStatus;
  expiresAt: number;
  gcTimer: ReturnType<typeof setTimeout> | undefined;
  errorMessage: string | undefined;
  resolvedAt: string | undefined;
}

const flows = new Map<string, FlowState>();

// ── Host-side auth surface ────────────────────────────────────────────────

/**
 * Resolve the OAuth toolkit for a call. Production entry points leave
 * `host.auth` empty and the service builds the default toolkit over
 * `host.homeDir`; hosts/tests may inject a pre-built toolkit (e.g. one wired
 * to a local OAuth server) through `host.auth = { toolkit }`.
 */
function getToolkit(ctx: RustCallContext): KimiOAuthToolkit {
  const injected = (ctx.host.auth as { readonly toolkit?: KimiOAuthToolkit } | undefined);
  const toolkit = injected?.toolkit;
  if (toolkit !== undefined) return toolkit;
  return getDefaultToolkit(ctx.host.homeDir);
}

const defaultToolkits = new Map<string, KimiOAuthToolkit>();

function getDefaultToolkit(homeDir: string): KimiOAuthToolkit {
  let toolkit = defaultToolkits.get(homeDir);
  if (toolkit === undefined) {
    toolkit = new KimiOAuthToolkit({ homeDir });
    defaultToolkits.set(homeDir, toolkit);
  }
  return toolkit;
}

// ── Config access (host-side read, engine-backed write) ───────────────────

function readConfig(ctx: RustCallContext): ManagedKimiConfigShape {
  return loadRuntimeConfigSafe(ctx.host.configPath).config as unknown as ManagedKimiConfigShape;
}

/** Persist a full config shape through the engine (configSet deep-merges). */
async function writeConfig(ctx: RustCallContext, config: ManagedKimiConfigShape): Promise<void> {
  await ctx.rust.configSet(config as unknown as Record<string, unknown>);
}

function readProviderOAuthRef(
  ctx: RustCallContext,
  provider: string,
): ManagedKimiOAuthRef | undefined {
  const record = readConfig(ctx).providers[provider];
  if (record === null || typeof record !== 'object') return undefined;
  return (record as { oauth?: ManagedKimiOAuthRef }).oauth;
}

function resolveRuntimeOAuthRef(
  ctx: RustCallContext,
  provider: string,
  oauthRef?: ManagedKimiOAuthRef | undefined,
): ManagedKimiOAuthRef | undefined {
  if (provider !== KIMI_CODE_PROVIDER_NAME) return oauthRef;
  const configured = readProviderOAuthRef(ctx, provider);
  return resolveKimiCodeRuntimeAuth({
    configuredBaseUrl: readProviderBaseUrl(ctx, provider),
    configuredOAuthRef: oauthRef ?? configured,
  }).oauthRef;
}

function readProviderBaseUrl(ctx: RustCallContext, provider: string): string | undefined {
  const record = readConfig(ctx).providers[provider];
  if (record === null || typeof record !== 'object') return undefined;
  return (record as { baseUrl?: string }).baseUrl;
}

// ── OAuth device flow ─────────────────────────────────────────────────────

async function startLogin(ctx: RustCallContext): Promise<OAuthFlowStart> {
  const provider = ctx.args[0] as string | undefined ?? KIMI_CODE_PROVIDER_NAME;
  const toolkit = getToolkit(ctx);
  const loginAuth = resolveLoginAuth(ctx, provider);
  abortExisting(provider);

  const state: FlowState = {
    flowId: `oauth_${randomUUID()}`,
    provider,
    controller: new AbortController(),
    oauthRef: loginAuth.oauthRef,
    loginBaseUrl: loginAuth.baseUrl,
    device: undefined,
    status: 'pending',
    expiresAt: Date.now() + DEFAULT_DEVICE_EXPIRES_IN_SEC * 1000,
    gcTimer: undefined,
    errorMessage: undefined,
    resolvedAt: undefined,
  };
  flows.set(provider, state);

  let resolveDevice!: (auth: DeviceAuthorization) => void;
  const deviceReady = new Promise<DeviceAuthorization>((resolve) => {
    resolveDevice = resolve;
  });

  const loginPromise = toolkit.login(provider, {
    signal: state.controller.signal,
    oauthRef: loginAuth.oauthRef,
    baseUrl: loginAuth.baseUrl,
    oauthHost: loginAuth.oauthHost,
    onDeviceCode: (auth) => {
      state.device = auth;
      if (auth.expiresIn !== null) {
        state.expiresAt = Date.now() + auth.expiresIn * 1000;
      }
      resolveDevice(auth);
    },
  });

  // Fast path: the toolkit resolves without a device code when a token is
  // already cached and fresh — surface the login as already authenticated.
  const fastPath: Promise<OAuthFlowStartAuthenticated | undefined> = loginPromise.then(async () => {
    if (state.device !== undefined) return undefined;
    await finalizeAuthentication(state, ctx);
    return { flow_id: state.flowId, provider: state.provider, status: 'authenticated' };
  });

  loginPromise.then(
    () => {
      if (state.device !== undefined) void finalizeAuthentication(state, ctx);
    },
    (error) => {
      handleFailure(state, error);
    },
  );

  const winner = await Promise.race([
    deviceReady.then((device) => ({ kind: 'device' as const, device })),
    fastPath.then((result) => ({ kind: 'fast' as const, result })),
  ]);
  // `fast` resolving without a result means the device code had already
  // arrived when the toolkit resolved — fall through to the device start.
  if (winner.kind === 'fast' && winner.result !== undefined) return winner.result;
  const device = winner.kind === 'device' ? winner.device : await deviceReady;
  return toFlowStart(state, device);
}

async function getFlow(ctx: RustCallContext): Promise<OAuthFlowSnapshot | undefined> {
  const provider = ctx.args[0] as string | undefined ?? KIMI_CODE_PROVIDER_NAME;
  const state = flows.get(provider);
  if (state === undefined || state.device === undefined) return undefined;
  return toSnapshot(state, state.device);
}

function cancelLogin(ctx: RustCallContext): Promise<OAuthLoginCancelResponse> {
  const provider = ctx.args[0] as string | undefined ?? KIMI_CODE_PROVIDER_NAME;
  const state = flows.get(provider);
  if (state === undefined || state.status !== 'pending') {
    return Promise.resolve({ cancelled: false, status: state?.status ?? 'cancelled' });
  }
  state.controller.abort();
  setTerminal(state, 'cancelled');
  return Promise.resolve({ cancelled: true, status: 'cancelled' });
}

async function logout(ctx: RustCallContext): Promise<OAuthLogoutResponse> {
  const provider = ctx.args[0] as string | undefined ?? KIMI_CODE_PROVIDER_NAME;
  const toolkit = getToolkit(ctx);
  const oauthRef =
    provider === KIMI_CODE_PROVIDER_NAME
      ? resolveRuntimeOAuthRef(ctx, provider)
      : readProviderOAuthRef(ctx, provider);
  const result = await toolkit.logout(provider, oauthRef);
  abortExisting(provider);
  await deprovisionProvider(ctx);
  return { logged_out: true, provider: result.providerName };
}

async function status(ctx: RustCallContext): Promise<AuthStatus> {
  const provider = ctx.args[0] as string | undefined ?? KIMI_CODE_PROVIDER_NAME;
  return statusFor(ctx, provider);
}

/** Serialize refreshes so concurrent calls never race the config read-modify-write. */
const refreshChain: { next: Promise<unknown> } = { next: Promise.resolve() };

async function refreshOAuthProviderModels(
  ctx: RustCallContext,
): Promise<RefreshOAuthProviderModelsResponse> {
  const run = refreshChain.next.then(() => doRefreshOAuthProviderModels(ctx));
  refreshChain.next = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function doRefreshOAuthProviderModels(
  ctx: RustCallContext,
): Promise<RefreshOAuthProviderModelsResponse> {
  const toolkit = getToolkit(ctx);
  const host: RefreshProviderHost = {
    getConfig: async () => readConfig(ctx),
    removeProvider: async (providerId) => {
      const config = readConfig(ctx);
      delete config.providers[providerId];
      if (config.models !== undefined) {
        for (const [alias, model] of Object.entries(config.models)) {
          if (
            model !== null &&
            typeof model === 'object' &&
            (model as { provider?: unknown }).provider === providerId
          ) {
            delete config.models[alias];
          }
        }
      }
      await writeConfig(ctx, config);
      return config;
    },
    setConfig: async (patch) => {
      await writeConfig(ctx, patch);
      return patch;
    },
    resolveOAuthToken: async (providerName, oauthRef) =>
      toolkit.tokenProvider(providerName, oauthRef).getAccessToken(),
  };
  const result = await refreshProviderModels(host, { scope: 'oauth' });
  return {
    changed: result.changed.map((change) => ({
      provider_id: change.providerId,
      provider_name: change.providerName,
      added: change.added,
      removed: change.removed,
    })),
    unchanged: [...result.unchanged],
    failed: result.failed.map((failure) => ({ provider: failure.provider, reason: failure.reason })),
  };
}

// ── Flow internals ────────────────────────────────────────────────────────

function resolveLoginAuth(
  ctx: RustCallContext,
  provider: string,
): {
  readonly oauthRef: ManagedKimiOAuthRef | undefined;
  readonly baseUrl: string | undefined;
  readonly oauthHost: string | undefined;
} {
  if (provider !== KIMI_CODE_PROVIDER_NAME) {
    return { oauthRef: readProviderOAuthRef(ctx, provider), baseUrl: undefined, oauthHost: undefined };
  }
  const loginAuth = resolveKimiCodeLoginAuth({
    configuredBaseUrl: readProviderBaseUrl(ctx, provider),
    configuredOAuthRef: readProviderOAuthRef(ctx, provider),
  });
  const oauthRef =
    loginAuth.oauthRef ??
    resolveKimiCodeOAuthRef({ oauthHost: loginAuth.oauthHost, baseUrl: loginAuth.baseUrl });
  return {
    oauthRef,
    baseUrl: loginAuth.baseUrl,
    oauthHost: loginAuth.oauthHost,
  };
}

function abortExisting(provider: string): void {
  const existing = flows.get(provider);
  if (existing !== undefined && existing.status === 'pending') {
    existing.controller.abort();
    setTerminal(existing, 'cancelled');
  }
}

async function finalizeAuthentication(state: FlowState, ctx: RustCallContext): Promise<void> {
  try {
    await provisionProvider(state, ctx);
    if (state.status !== 'pending') return;
    if (state.provider === KIMI_CODE_PROVIDER_NAME) {
      await refreshOAuthProviderModelsBestEffort(ctx);
      if (state.status !== 'pending') return;
    }
  } catch {
    // Best effort: provisioning/model-refresh failures must not break the
    // already-established login (mirrors agent-core-v2).
  } finally {
    if (state.status === 'pending') {
      setTerminal(state, 'authenticated');
    }
  }
}

async function provisionProvider(state: FlowState, ctx: RustCallContext): Promise<void> {
  const oauthRef = state.oauthRef;
  if (oauthRef === undefined && state.provider !== KIMI_CODE_PROVIDER_NAME) return;
  const config = readConfig(ctx);
  const existing = config.providers[state.provider];
  const baseUrl =
    state.loginBaseUrl ??
    (existing !== null && typeof existing === 'object'
      ? (existing as { baseUrl?: string }).baseUrl
      : undefined);
  config.providers[state.provider] = {
    type: 'kimi',
    baseUrl: baseUrl ?? kimiCodeBaseUrl(),
    apiKey: '',
    oauth: oauthRef,
  };
  await writeConfig(ctx, config);
}

async function refreshOAuthProviderModelsBestEffort(ctx: RustCallContext): Promise<void> {
  await refreshOAuthProviderModels(ctx);
}

async function deprovisionProvider(ctx: RustCallContext): Promise<void> {
  const config = readConfig(ctx);
  const managed = config.providers[KIMI_CODE_PROVIDER_NAME];
  const managedModels = Object.entries(config.models ?? {}).some(
    ([, model]) =>
      model !== null &&
      typeof model === 'object' &&
      (model as { provider?: unknown }).provider === KIMI_CODE_PROVIDER_NAME,
  );
  if (managed === undefined && !managedModels) return;
  applyManagedKimiCodeLogoutConfig(config);
  await writeConfig(ctx, config);
}

function handleFailure(state: FlowState, err: unknown): void {
  if (state.status !== 'pending') return;
  state.errorMessage = err instanceof Error ? err.message : String(err);
  setTerminal(state, classifyFailure(err));
}

function classifyFailure(err: unknown): OAuthFlowStatus {
  const message = err instanceof Error ? err.message : String(err);
  if (message.toLowerCase().includes('expired')) return 'expired';
  if (message.toLowerCase().includes('aborted')) return 'cancelled';
  return 'denied';
}

function setTerminal(state: FlowState, status: OAuthFlowStatus): void {
  state.status = status;
  state.resolvedAt = new Date().toISOString();
  const timer = setTimeout(() => {
    if (flows.get(state.provider) === state) {
      flows.delete(state.provider);
    }
  }, TERMINAL_RETENTION_MS);
  timer.unref();
  state.gcTimer = timer;
}

function toFlowStart(state: FlowState, device: DeviceAuthorization): OAuthFlowStartPending {
  const expiresIn = device.expiresIn ?? DEFAULT_DEVICE_EXPIRES_IN_SEC;
  return {
    flow_id: state.flowId,
    provider: state.provider,
    status: 'pending',
    verification_uri: device.verificationUri,
    verification_uri_complete: device.verificationUriComplete,
    user_code: device.userCode,
    expires_in: expiresIn,
    interval: device.interval,
    expires_at: new Date(state.expiresAt).toISOString(),
  };
}

function toSnapshot(state: FlowState, device: DeviceAuthorization): OAuthFlowSnapshot {
  return {
    ...toFlowStart(state, device),
    status: state.status,
    resolved_at: state.resolvedAt,
    error_message: state.errorMessage,
  };
}

// ── authSummaryService ────────────────────────────────────────────────────

async function summarize(ctx: RustCallContext): Promise<AuthStatus[]> {
  const providers = readConfig(ctx).providers;
  const oauthProviders = Object.entries(providers).filter(
    ([, config]) =>
      config !== null &&
      typeof config === 'object' &&
      (config as { oauth?: unknown }).oauth !== undefined,
  );
  const statuses: AuthStatus[] = [];
  for (const [name] of oauthProviders) {
    try {
      statuses.push(await statusFor(ctx, name));
    } catch {
      // A failing provider must not break the whole summary (mirrors v2).
    }
  }
  return statuses;
}

async function ensureReady(ctx: RustCallContext): Promise<void> {
  const modelOverride = ctx.args[0] as string | undefined;
  const config = readConfig(ctx);
  const providers = config.providers;
  const models = config.models ?? {};
  const modelId = modelOverride ?? config.defaultModel;

  if (Object.keys(providers).length === 0 && modelId === undefined) {
    throw new Error('No provider configured — run login first.');
  }
  if (modelId === undefined || modelId === '') {
    throw new Error(`No model resolved (model id: ${modelId ?? 'none'}).`);
  }
  const model = models[modelId];
  if (model === null || typeof model !== 'object') {
    throw new Error(`Model "${modelId}" is not configured.`);
  }
  const record = model as { provider?: string; baseUrl?: string; apiKey?: string; oauth?: unknown };
  const providerId = record.provider ?? providerNameFromBaseUrl(record.baseUrl);
  if (providerId === undefined) {
    throw new Error(`Model "${modelId}" has no provider.`);
  }
  const providerConfig = providers[providerId];
  if (providerConfig === undefined) {
    throw new Error(`Model "${modelId}" references unknown provider "${providerId}".`);
  }
  const oauth = (providerConfig as { oauth?: ManagedKimiOAuthRef }).oauth;
  if (oauth === undefined) return;
  const token = await getToolkit(ctx).getCachedAccessToken(providerId, oauth);
  if (token === undefined) {
    throw new Error(`Provider "${providerId}" is not logged in.`);
  }
}

function providerNameFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

async function statusFor(ctx: RustCallContext, provider: string): Promise<AuthStatus> {
  const toolkit = getToolkit(ctx);
  const oauthRef = resolveRuntimeOAuthRef(ctx, provider, readProviderOAuthRef(ctx, provider));
  const token = await toolkit.getCachedAccessToken(provider, oauthRef);
  return token === undefined ? { loggedIn: false } : { loggedIn: true, provider };
}

// ── Service registration ──────────────────────────────────────────────────

export const oauthService: RustServiceRegistry = {
  startLogin,
  getFlow,
  cancelLogin,
  logout,
  status,
  refreshOAuthProviderModels,
};

export const authSummaryService: RustServiceRegistry = {
  summarize,
  ensureReady,
};

registerService('oauthService', oauthService);
registerService('authSummaryService', authSummaryService);
