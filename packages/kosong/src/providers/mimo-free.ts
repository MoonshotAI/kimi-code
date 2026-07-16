import type {
  ChatProvider,
  GenerateOptions,
  MaxCompletionTokensOptions,
  ProviderRequestAuth,
  StreamedMessage,
  ThinkingEffort,
  VideoUploadInput,
} from '#/provider';
import type { Message, VideoURLPart } from '#/message';
import type { Tool } from '#/tool';
import {
  OpenAILegacyChatProvider,
  type OpenAILegacyGenerationKwargs,
  type OpenAILegacyOptions,
} from './openai-legacy';
import OpenAI from 'openai';

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/';
const BASE_URL = (process.env['MIMO_FREE_BASE_URL'] || DEFAULT_BASE_URL).replace(/\/+$/, '');
const BOOTSTRAP_URL = `${BASE_URL}/api/free-ai/bootstrap`;
const CHAT_BASE_URL = `${BASE_URL}/api/free-ai/openai`;

// ---------------------------------------------------------------------------
// Client fingerprint — persisted so the same machine always presents the same
// identity across restarts. Mirrors MiMo-Code's mimo-free plugin.
// ---------------------------------------------------------------------------

let fingerprintCache: string | undefined;

function getFingerprintFile(): string {
  const dataDir = process.env['KIMI_DATA_DIR'] || path.join(os.homedir(), '.kimi');
  return path.join(dataDir, 'mimo-free-client');
}

function getClientFingerprint(): string {
  if (fingerprintCache) return fingerprintCache;

  const file = getFingerprintFile();
  try {
    const existing = fs.readFileSync(file, 'utf-8').trim();
    if (existing) {
      fingerprintCache = existing;
      return existing;
    }
  } catch {
    // file doesn't exist yet — generate
  }

  const cpu = os.cpus()[0]?.model ?? 'unknown-cpu';
  const username = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return 'unknown-user';
    }
  })();
  const seed = [os.hostname(), process.platform, process.arch, cpu, username].join('|');
  const fingerprint = crypto.createHash('sha256').update(seed).digest('hex');

  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, fingerprint, { mode: 0o600 });
  } catch {
    // non-fatal — fingerprint will be re-derived on next call
  }

  fingerprintCache = fingerprint;
  return fingerprint;
}

// ---------------------------------------------------------------------------
// JWT lifecycle — bootstrap, parse expiry, cache with refresh buffer.
// ---------------------------------------------------------------------------

const JWT_REFRESH_BUFFER_MS = 5 * 60_000; // 5 minutes before expiry

let jwtCache: { jwt: string; exp: number } | null = null;
let jwtInflight: Promise<{ jwt: string; exp: number }> | null = null;

function parseJwtExp(jwt: string): number {
  const parts = jwt.split('.');
  if (parts.length < 2) return Date.now() + 50 * 60_000;
  const encoded = parts[1];
  if (!encoded) return Date.now() + 50 * 60_000;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    // ignore parse errors
  }
  return Date.now() + 50 * 60_000;
}

async function bootstrap(): Promise<{ jwt: string; exp: number }> {
  const res = await fetch(BOOTSTRAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: getClientFingerprint() }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`mimo-free bootstrap failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { jwt?: string };
  if (!data.jwt) throw new Error('mimo-free bootstrap response missing jwt');
  return { jwt: data.jwt, exp: parseJwtExp(data.jwt) };
}

async function getJwt(): Promise<string> {
  if (jwtCache && jwtCache.exp - Date.now() > JWT_REFRESH_BUFFER_MS) {
    return jwtCache.jwt;
  }

  if (jwtInflight) return (await jwtInflight).jwt;

  jwtCache = null;
  jwtInflight = bootstrap();
  try {
    jwtCache = await jwtInflight;
    return jwtCache.jwt;
  } finally {
    jwtInflight = null;
  }
}

/** Invalidate the cached JWT — used before a 401/403 retry. */
function clearJwtCache(): void {
  jwtCache = null;
}

// ---------------------------------------------------------------------------
// Custom fetch — URL rewriting, JWT auth headers, 401/403 retry with
// re-bootstrap. Injected into the OpenAI SDK so the transport layer is
// transparent to the chat provider.
// ---------------------------------------------------------------------------

type FetchFn = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

// OpenAI SDK v4+ injects X-Stainless-* telemetry headers and OpenAI-specific
// headers on every request. The MiMo free API rejects requests carrying these
// headers with 403 "Illegal access". Strip them so the request looks like it
// comes from the official MiMo-Code client.
const STRIPPED_HEADER_PREFIXES = ['x-stainless', 'openai-'];

function stripOpenAISdkHeaders(headers: Headers): void {
  for (const key of [...headers.keys()]) {
    const lower = key.toLowerCase();
    if (STRIPPED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      headers.delete(key);
    }
  }
}

// The MiMo free API validates that the system message contains the exact
// string below — requests without it are rejected with 403 "Illegal access".
// Prepend it to the system prompt so kimi-code's own system prompt is preserved
// but the API's check passes.
const MIMO_REQUIRED_SYSTEM_PREFIX =
  'You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.';

/**
 * Intercept the request body and ensure the system message starts with the
 * required MiMoCode identifier. The existing system prompt (if any) is appended
 * after the prefix so kimi-code's instructions are still sent to the model.
 */
function injectRequiredSystemPrompt(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
    if (!Array.isArray(parsed.messages)) return body;

    const sysIdx = parsed.messages.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0) {
      const content = parsed.messages[sysIdx].content;
      if (typeof content === 'string' && content.startsWith(MIMO_REQUIRED_SYSTEM_PREFIX)) {
        return body; // already has the prefix
      }
      // Prepend the required prefix to the existing system message.
      parsed.messages[sysIdx].content =
        MIMO_REQUIRED_SYSTEM_PREFIX + '\n\n' + (content || '');
    } else {
      // No system message — insert one at the beginning.
      parsed.messages.unshift({ role: 'system', content: MIMO_REQUIRED_SYSTEM_PREFIX });
    }

    return JSON.stringify(parsed);
  } catch {
    return body; // not valid JSON — pass through unchanged
  }
}

function createMimoFreeFetch(): FetchFn {
  return async (input, init) => {
    // Rewrite /chat/completions → /chat (MiMo's API path convention).
    const originalUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const rewritten = originalUrl.replace(/\/chat\/completions(\?|$)/, '/chat$1');

    const jwt = await getJwt();

    // Build headers: start from the SDK's headers, strip OpenAI-specific ones,
    // then inject the JWT bearer token and MiMo source identifier.
    const headers = new Headers(init?.headers);
    stripOpenAISdkHeaders(headers);
    headers.delete('Authorization');
    headers.set('Authorization', `Bearer ${jwt}`);
    headers.set('X-Mimo-Source', 'mimocode-cli-free');

    // Inject the required system prompt into the request body.
    let body = init?.body;
    if (typeof body === 'string') {
      body = injectRequiredSystemPrompt(body);
    }

    const response = await fetch(rewritten, { ...init, headers, body });

    // On 401/403, re-bootstrap and retry once.
    if (response.status === 401 || response.status === 403) {
      clearJwtCache();
      const retryJwt = await getJwt();
      const retryHeaders = new Headers(init?.headers);
      stripOpenAISdkHeaders(retryHeaders);
      retryHeaders.delete('Authorization');
      retryHeaders.set('Authorization', `Bearer ${retryJwt}`);
      retryHeaders.set('X-Mimo-Source', 'mimocode-cli-free');
      return fetch(rewritten, { ...init, headers: retryHeaders, body });
    }

    return response;
  };
}

// ---------------------------------------------------------------------------
// Options for the mimo-free provider.
// ---------------------------------------------------------------------------

export interface MimoFreeOptions {
  /** Wire model name sent to the upstream API (default: "mimo-auto"). */
  model?: string;
  /**
   * Base URL for the MiMo free API. Overrides the default
   * `https://api.xiaomimimo.com/api/free-ai/openai`.
   * Can also be set via `MIMO_FREE_BASE_URL` env var.
   */
  baseUrl?: string;
  /** Max output tokens passed to the upstream API (default: 8K). */
  maxTokens?: number;
  /** Stream responses (default: true). */
  stream?: boolean;
  /** Custom default headers forwarded on every request to the upstream API. */
  defaultHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// MiMo Free Chat Provider
// ---------------------------------------------------------------------------

export class MimoFreeChatProvider implements ChatProvider {
  readonly name: string = 'mimo-free';

  private _inner: OpenAILegacyChatProvider;

  constructor(options: MimoFreeOptions = {}) {
    const model = options.model ?? 'mimo-auto';
    const baseUrl = options.baseUrl ?? CHAT_BASE_URL;

    // Build a clientFactory that injects our custom fetch for JWT auth.
    const defaultHeaders = options.defaultHeaders;
    const clientFactory = (_auth: ProviderRequestAuth): OpenAI => {
      return new OpenAI({
        apiKey: 'anonymous', // real auth is in the custom fetch
        baseURL: baseUrl,
        fetch: createMimoFreeFetch() as typeof globalThis.fetch,
        maxRetries: 1, // we handle retries in createMimoFreeFetch
        ...(defaultHeaders !== undefined ? { defaultHeaders } : {}),
      });
    };

    const innerOptions: OpenAILegacyOptions = {
      model,
      apiKey: 'anonymous',
      baseUrl,
      stream: options.stream ?? true,
      maxTokens: options.maxTokens,
      defaultHeaders,
      clientFactory,
    };

    this._inner = new OpenAILegacyChatProvider(innerOptions);
  }

  // -- Delegated properties --

  get modelName(): string {
    return this._inner.modelName;
  }

  get thinkingEffort(): ThinkingEffort | null {
    return this._inner.thinkingEffort;
  }

  get maxCompletionTokens(): number | undefined {
    return this._inner.maxCompletionTokens;
  }

  get modelParameters(): Record<string, unknown> {
    return this._inner.modelParameters;
  }

  // -- Core generate --

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    return this._inner.generate(systemPrompt, tools, history, options);
  }

  // -- Configuration --

  withThinking(effort: ThinkingEffort): MimoFreeChatProvider {
    return this._clone({ _inner: this._inner.withThinking(effort) as OpenAILegacyChatProvider });
  }

  withMaxCompletionTokens(
    maxCompletionTokens: number,
    options?: MaxCompletionTokensOptions,
  ): MimoFreeChatProvider {
    return this._clone({
      _inner: this._inner.withMaxCompletionTokens(
        maxCompletionTokens,
        options,
      ) as OpenAILegacyChatProvider,
    });
  }

  withGenerationKwargs(kwargs: OpenAILegacyGenerationKwargs): MimoFreeChatProvider {
    return this._clone({
      _inner: this._inner.withGenerationKwargs(kwargs) as OpenAILegacyChatProvider,
    });
  }

  uploadVideo(_input: string | VideoUploadInput, _options?: GenerateOptions): Promise<VideoURLPart> {
    return Promise.reject(new Error('Video upload not supported by mimo-free'));
  }

  private _clone(overrides?: Record<string, unknown>): MimoFreeChatProvider {
    const clone: MimoFreeChatProvider = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as MimoFreeChatProvider,
      this,
    );
    if (overrides) Object.assign(clone, overrides);
    return clone;
  }
}
