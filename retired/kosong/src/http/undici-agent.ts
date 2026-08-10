/**
 * Shared undici Agent with tuned keep-alive for upstream LLM providers.
 *
 * The Anthropic, OpenAI Chat Completions, and OpenAI Responses SDKs all
 * delegate to `globalThis.fetch`, which under Node 24 maps to undici
 * with the default global Agent: 50 idle conns, 5 s connect timeout,
 * no explicit keep-alive tuning. The CLI is a short-lived process that
 * issues a handful of LLM calls in a single session, so the first
 * cold call of each session pays the full TCP+TLS setup cost.
 *
 * This module returns a single shared Agent that the SDKs route
 * their traffic through, both cutting the cold-call latency and
 * keeping warm-call reuse predictable.
 *
 * The Agent is lazy: no connections open until the first request
 * actually goes out, so importing this module is free.
 */
import { existsSync, readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

// ── System CA loading (for providers with non-public CAs, e.g. xfyun.cn) ────

const SYSTEM_CA_PATHS = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
];

let _systemCaCerts: string[] | undefined;

/**
 * Return the system CA certificates concatenated with Node's built-in root
 * certificates. Idempotent: loads once and caches.
 *
 * Needed for providers whose TLS certificates chain to a CA that is in the
 * system trust store but not in the Mozilla CA bundle shipped with Node
 * (e.g. Chinese CAs for xfyun.cn).
 */
export function loadSystemCAs(): string[] {
  if (_systemCaCerts) return _systemCaCerts;
  let systemCerts = '';
  for (const path of SYSTEM_CA_PATHS) {
    if (existsSync(path)) {
      try {
        systemCerts = readFileSync(path, 'utf-8');
        break;
      } catch { /* ignore */ }
    }
  }
  _systemCaCerts = [systemCerts, ...rootCertificates].filter(Boolean);
  return _systemCaCerts;
}

let cachedAgent: Agent | undefined;

/**
 * Return the process-wide shared Agent. Idempotent: the same Agent
 * instance is returned on every call so the SDKs all share the
 * connection pool.
 */
export function createSharedAgent(): Agent {
  if (cachedAgent === undefined) {
    cachedAgent = new Agent({
      // Keep idle connections around across SDK calls. 60 s matches
      // the long-lived keep-alive typical LLM provider edges prefer,
      // and avoids reconnecting when the next turn starts a few
      // seconds after the previous one finished.
      keepAliveTimeout: 60_000,
      // Allow multiple concurrent requests to share a connection
      // when the server supports HTTP/1.1 pipelining. Anthropic and
      // OpenAI do not pipeline today, so this is a free option for
      // the future rather than an immediate win.
      pipelining: 1,
      // Cap the pool so a runaway caller cannot open hundreds of
      // sockets to the same origin.
      connections: 64,
      // Connect timeout: long enough for slow residential links,
      // short enough that a dead host fails fast instead of hanging
      // the whole turn.
      connectTimeout: 5_000,
      // Headers timeout: bounded separately so a server that accepts
      // the connection but stalls on response headers does not pin a
      // socket for minutes.
      headersTimeout: 15_000,
      // Body timeout: same reasoning for response bodies. The SDK
      // will read streaming bodies incrementally, but undici
      // measures time between body chunks too.
      bodyTimeout: 120_000,
      // Include system CA certs alongside Node's built-in roots so
      // providers with non-Mozilla CAs (e.g. xfyun.cn) are trusted.
      connect: buildConnector({ ca: loadSystemCAs() }),
    });
  }
  return cachedAgent;
}

/**
 * Build a `fetch`-compatible function that routes every call through
 * the shared undici Agent. Use this with SDKs that expose a `fetch`
 * option (Anthropic, OpenAI v6).
 */
export function createSharedFetch(): typeof fetch {
  const agent = createSharedAgent();
  return (input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    }) as unknown as ReturnType<typeof fetch>;
}
