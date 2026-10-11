import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici';

export const LLM_HEADERS_TIMEOUT_ENV = 'KIMI_CODE_LLM_HEADERS_TIMEOUT_MS';
export const LLM_STREAM_IDLE_TIMEOUT_ENV = 'KIMI_CODE_LLM_STREAM_IDLE_TIMEOUT_MS';

export const DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS = 300_000;

const MAX_HEADERS_TIMEOUT_MS = 2 ** 31 - 1;

type Env = Readonly<Record<string, string | undefined>>;

export function resolveLlmHeadersTimeoutMs(env: Env = process.env): number | undefined {
  const raw = env[LLM_HEADERS_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_HEADERS_TIMEOUT_MS) {
    throw new Error(
      `${LLM_HEADERS_TIMEOUT_ENV} must be a positive integer no greater than ${MAX_HEADERS_TIMEOUT_MS}, got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

export function resolveLlmStreamIdleTimeoutMs(env: Env = process.env): number {
  const raw = env[LLM_STREAM_IDLE_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${LLM_STREAM_IDLE_TIMEOUT_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

export class StreamIdleTimeoutError extends Error {
  constructor(idleTimeoutMs: number) {
    super(`LLM response stream idle timeout: no data received for ${idleTimeoutMs} ms.`);
    this.name = 'StreamIdleTimeoutError';
  }
}

export type AsyncIterableValue<S> = S extends AsyncIterable<infer T> ? T : never;

export interface LlmStreamWatchdog {
  readonly signal: AbortSignal;
  watch<S extends AsyncIterable<unknown>>(stream: S): AsyncIterable<AsyncIterableValue<S>>;
}

export function createLlmStreamWatchdog(
  signal: AbortSignal,
  idleTimeoutMs: number,
): LlmStreamWatchdog {
  const controller = new AbortController();
  return {
    signal: AbortSignal.any([signal, controller.signal]),
    async *watch<S extends AsyncIterable<unknown>>(
      stream: S,
    ): AsyncIterable<AsyncIterableValue<S>> {
      const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<AsyncIterableValue<S>>;
      try {
        for (;;) {
          let rejectIdle!: (error: StreamIdleTimeoutError) => void;
          const idle = new Promise<never>((_, reject) => {
            rejectIdle = reject;
          });
          const timer = setTimeout(() => {
            controller.abort();
            rejectIdle(new StreamIdleTimeoutError(idleTimeoutMs));
          }, idleTimeoutMs);
          timer.unref?.();
          const next = iterator.next();
          let result: IteratorResult<AsyncIterableValue<S>>;
          try {
            result = await Promise.race([next, idle]);
          } catch (error: unknown) {
            next.catch(() => {});
            throw error;
          } finally {
            clearTimeout(timer);
          }
          if (result.done === true) {
            return;
          }
          yield result.value;
        }
      } finally {
        await iterator.return?.().catch(() => {});
      }
    },
  };
}

const SOCKS_SCHEMES = new Set(['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']);
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'] as const;

function schemeOf(value: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
}

function firstNonBlank(env: Env, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function httpSchemeValue(value: string | undefined): string | undefined {
  return value !== undefined && !SOCKS_SCHEMES.has(schemeOf(value) ?? '') ? value : undefined;
}

function resolveHttpProxyUrls(env: Env): { httpProxy?: string; httpsProxy?: string } | undefined {
  const allProxy = httpSchemeValue(firstNonBlank(env, ['all_proxy', 'ALL_PROXY']));
  const httpProxy = httpSchemeValue(firstNonBlank(env, ['http_proxy', 'HTTP_PROXY'])) ?? allProxy;
  const httpsProxy = httpSchemeValue(firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY'])) ?? allProxy;
  if (httpProxy === undefined && httpsProxy === undefined) return undefined;
  return { httpProxy, httpsProxy };
}

function hasSocksProxy(env: Env): boolean {
  return [
    firstNonBlank(env, ['all_proxy', 'ALL_PROXY']),
    firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY']),
    firstNonBlank(env, ['http_proxy', 'HTTP_PROXY']),
  ].some((value) => value !== undefined && SOCKS_SCHEMES.has(schemeOf(value) ?? ''));
}

function resolveNoProxy(env: Env): string {
  const raw =
    [env['no_proxy'], env['NO_PROXY']].find((value) => (value?.trim() ?? '').length > 0) ?? '';
  const hosts = raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (hosts.includes('*')) return '*';
  for (const loopback of LOOPBACK_NO_PROXY) {
    if (!hosts.includes(loopback)) hosts.push(loopback);
  }
  return hosts.join(',');
}

let warnedSocksProxy = false;
let warnedInvalidProxy = false;
let cached: { readonly key: string; readonly dispatcher: Dispatcher | undefined } | undefined;

export function getLlmDispatcher(
  headersTimeoutMs: number | undefined,
  env: Env = process.env,
): Dispatcher | undefined {
  const key = JSON.stringify([
    headersTimeoutMs ?? null,
    env['http_proxy'],
    env['HTTP_PROXY'],
    env['https_proxy'],
    env['HTTPS_PROXY'],
    env['all_proxy'],
    env['ALL_PROXY'],
    env['no_proxy'],
    env['NO_PROXY'],
  ]);
  if (cached?.key === key) return cached.dispatcher;
  let dispatcher: Dispatcher | undefined;
  const httpProxyUrls = resolveHttpProxyUrls(env);
  if (httpProxyUrls !== undefined) {
    try {
      dispatcher = new EnvHttpProxyAgent({
        httpProxy: httpProxyUrls.httpProxy ?? '',
        httpsProxy: httpProxyUrls.httpsProxy ?? '',
        noProxy: resolveNoProxy(env),
        bodyTimeout: 0,
        headersTimeout: headersTimeoutMs,
      });
    } catch (error) {
      if (!warnedInvalidProxy) {
        warnedInvalidProxy = true;
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `kimi: ignoring invalid proxy configuration (${reason}); LLM requests fall back to the default transport and ${LLM_HEADERS_TIMEOUT_ENV} is not applied\n`,
        );
      }
      dispatcher = undefined;
    }
  } else if (hasSocksProxy(env)) {
    if (!warnedSocksProxy) {
      warnedSocksProxy = true;
      process.stderr.write(
        `kimi: LLM request timeout overrides (${LLM_HEADERS_TIMEOUT_ENV}, ${LLM_STREAM_IDLE_TIMEOUT_ENV}) are not supported with SOCKS proxies; requests keep the transport defaults\n`,
      );
    }
    dispatcher = undefined;
  } else {
    dispatcher = new Agent({ bodyTimeout: 0, headersTimeout: headersTimeoutMs });
  }
  cached = { key, dispatcher };
  return dispatcher;
}
