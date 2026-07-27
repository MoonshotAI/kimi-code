/**
 * Probe the ModelRequester problem boundary, in two parts.
 *
 * Part 1 — real config: bootstraps the agent-core-v2 App scope on the REAL
 * Kimi home (`KIMI_CODE_HOME` or `~/.kimi-code`), resolves `IModelCatalog`
 * with the providers/auth from `config.toml`, lists every provider/model, and
 * pings every configured model through its `ModelRequester` (one tiny live
 * request per model, real credentials). This is the "does the assembled
 * pipeline actually reach each provider" smoke.
 *
 * Part 2 — deterministic boundary probes: points hand-built Models at a local
 * stub HTTP server (OpenAI Chat Completions wire) and drives failure modes
 * through `ModelRequesterImpl`, recording for each one WHO owned it:
 *
 *   - wrapped by ChatProvider  — the wire adapter converted the SDK/transport
 *     failure into the typed `ChatProviderError` family (APIStatusError /
 *     APIConnectionError / APIEmptyResponseError / ...), so the requester could
 *     translate it into a coded `Error2` (`provider.*` / `context.overflow`).
 *   - owned by ModelRequester  — behavior the ChatProvider layer CANNOT
 *     provide: per-request auth injection and the OAuth 401 → force-refresh →
 *     single replay, plus the final `translateProviderError` safety net that
 *     turns even unwrapped raw errors into `Error2` (`internal`).
 *   - owned by neither         — user cancellation: the standard AbortError
 *     DOMException passes through BOTH layers untranslated, by design.
 *
 * Tool-call probes cover the decode/encode boundary specifically: streamed
 * `delta.tool_calls` assembly (single, parallel-interleaved, index-less),
 * malformed arguments (deliberately NOT the wire layer's problem), the
 * strict-provider tool-exchange 400 staying recognizable through the wrap,
 * and request-side encoding of tool declarations and tool results.
 *
 * Run (the examples tsconfig enables the decorators the engine sources need):
 *   pnpm -C packages/klient smoke:boundary
 *
 * Env:
 *   KIMI_CODE_HOME        — default `~/.kimi-code`
 *   KIMI_BOUNDARY_MODELS  — comma-separated model ids to ping (default: all)
 *   KIMI_BOUNDARY_SKIP_LIVE — set to `1` to skip part 1 (no real API calls)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import { isError2 } from '@moonshot-ai/agent-core-v2/_base/errors/errors';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { UNKNOWN_CAPABILITY } from '@moonshot-ai/agent-core-v2/kosong/contract/capability';
import {
  APIContextOverflowError,
  APIStatusError,
  ChatProviderError,
  isAbortError,
  isToolExchangeAdjacencyError,
} from '@moonshot-ai/agent-core-v2/kosong/contract/errors';
import type { ToolCall } from '@moonshot-ai/agent-core-v2/kosong/contract/message';
import type { Tool } from '@moonshot-ai/agent-core-v2/kosong/contract/tool';
import type { AuthProvider, Model } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import type {
  ModelRequestInput,
  ModelRequester,
} from '@moonshot-ai/agent-core-v2/kosong/model/modelRequester';
import { ModelRequesterImpl } from '@moonshot-ai/agent-core-v2/kosong/model/modelRequesterImpl';
import { ProtocolAdapterRegistry } from '@moonshot-ai/agent-core-v2/kosong/provider/protocolAdapterRegistry';

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Part 1 — real config.toml: catalog listing + per-model live ping.
// ---------------------------------------------------------------------------

async function probeRealConfig(): Promise<void> {
  const homeDir = process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
  console.log(`\n=== part 1: real config (${homeDir}/config.toml) ===`);
  const { app } = bootstrap({ homeDir }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]);
  try {
    // Config (and every section on top of it) loads asynchronously.
    await app.accessor.get(IConfigService).ready;
    const catalog = app.accessor.get(IModelCatalog);

    const providers = await catalog.listProviders();
    for (const p of providers) {
      console.log(
        `[provider] ${p.id}  type=${p.type}  status=${p.status}  ` +
          `has_api_key=${p.has_api_key}  models=${(p.models ?? []).length}`,
      );
    }

    const models = await catalog.listModels();
    const filter = process.env['KIMI_BOUNDARY_MODELS']?.split(',').map((s) => s.trim());
    const targets = models.filter((m) => filter === undefined || filter.includes(m.model));
    assert(targets.length > 0, 'at least one configured model to ping');

    for (const m of targets) {
      const startedAt = Date.now();
      const result = await Promise.race([
        catalog.ping(m.model),
        tick(45_000).then(() => ({ ok: false as const, durationMs: 45_000, error: 'ping timed out after 45s' })),
      ]);
      if (result.ok) {
        console.log(
          `[ping ok]   ${m.model} (${m.provider})  ${String(Date.now() - startedAt)}ms  ` +
            `text=${JSON.stringify(result.text ?? '')}  finish=${String(result.finishReason)}  ` +
            `usage=${JSON.stringify(result.usage ?? null)}`,
        );
      } else {
        const firstLine = (result.error ?? 'unknown error').split('\n')[0];
        console.log(`[ping fail] ${m.model} (${m.provider})  ${firstLine}`);
      }
    }
  } finally {
    app.dispose();
  }
}

// ---------------------------------------------------------------------------
// Part 2 — stub-driven boundary probes.
// ---------------------------------------------------------------------------

const PING_INPUT: ModelRequestInput = {
  systemPrompt: 'You are a connectivity probe. Answer with the single word "pong".',
  tools: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }], toolCalls: [] }],
};

const WEATHER_TOOL: Tool = {
  name: 'get_weather',
  description: 'Get the weather for a city.',
  parameters: {
    type: 'object',
    properties: { location: { type: 'string' } },
    required: ['location'],
  },
};

const TOOL_INPUT: ModelRequestInput = { ...PING_INPUT, tools: [WEATHER_TOOL] };

/** A prior tool exchange: assistant tool call + its tool result. */
const TOOL_HISTORY_INPUT: ModelRequestInput = {
  systemPrompt: PING_INPUT.systemPrompt,
  tools: [WEATHER_TOOL],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'weather?' }], toolCalls: [] },
    {
      role: 'assistant',
      content: [],
      toolCalls: [
        {
          type: 'function',
          id: 'call_1',
          name: 'get_weather',
          arguments: '{"location":"Hangzhou"}',
        },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'sunny' }],
      toolCalls: [],
    },
  ],
};

interface Collected {
  readonly events: readonly string[];
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage?: unknown;
  readonly finishReason?: string | undefined;
}

async function collect(
  requester: ModelRequester,
  signal?: AbortSignal,
  input: ModelRequestInput = PING_INPUT,
): Promise<Collected> {
  const events: string[] = [];
  let text = '';
  let toolCalls: readonly ToolCall[] = [];
  let usage: unknown;
  let finishReason: string | undefined;
  for await (const event of requester.request(input, signal)) {
    events.push(event.type === 'part' ? `part:${event.part.type}` : event.type);
    if (event.type === 'part' && event.part.type === 'text') text += event.part.text;
    if (event.type === 'usage') usage = event.usage;
    if (event.type === 'finish') {
      finishReason = event.providerFinishReason ?? event.rawFinishReason;
      toolCalls = event.message.toolCalls;
    }
  }
  return { events, text, toolCalls, usage, finishReason };
}

// --- stub server -----------------------------------------------------------

type StubHandler = (req: IncomingMessage, res: ServerResponse) => void;

const sseChunk = (delta: object, finishReason: string | null): string =>
  JSON.stringify({
    id: 'chatcmpl-probe',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'probe-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

const sseToolDelta = (toolCalls: readonly object[], finishReason: string | null = null): string =>
  sseChunk({ tool_calls: toolCalls }, finishReason);

const SSE_USAGE = JSON.stringify({
  id: 'chatcmpl-probe',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'probe-model',
  choices: [],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
});

function writeSse(res: ServerResponse, chunks: readonly string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) res.write(`data: ${chunk}\n\n`);
  res.end('data: [DONE]\n\n');
}

function writePong(res: ServerResponse): void {
  writeSse(res, [
    sseChunk({ role: 'assistant' }, null),
    sseChunk({ content: 'pong' }, null),
    sseChunk({}, 'stop'),
    SSE_USAGE,
  ]);
}

function writeJsonError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: { message, type: 'stub_error' } }));
}

// --- probe bookkeeping ------------------------------------------------------

interface ProbeReport {
  readonly probe: string;
  readonly outcome: string;
  readonly wrappedBy: string;
}

const reports: ProbeReport[] = [];

/** Walk the cause chain looking for a typed ChatProviderError. */
function chatProviderCause(error: unknown): ChatProviderError | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (current instanceof ChatProviderError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function describeCaught(error: unknown): { outcome: string; wrappedBy: string } {
  if (isAbortError(error)) {
    return {
      outcome: `${error instanceof DOMException ? 'DOMException' : 'Error'} AbortError`,
      wrappedBy: 'neither — abort passes both layers untranslated (by design)',
    };
  }
  if (isError2(error)) {
    const cause = chatProviderCause(error.cause);
    return {
      outcome: `Error2 ${error.code} (cause: ${cause?.name ?? (error.cause instanceof Error ? error.cause.name : 'none')})`,
      wrappedBy:
        cause !== undefined
          ? 'ChatProvider wrapped → ModelRequester translated'
          : 'NOT wrapped by ChatProvider — raw error caught by the ModelRequester safety net',
    };
  }
  if (error instanceof ChatProviderError) {
    return { outcome: `raw ${error.name} (escaped translation!)`, wrappedBy: 'ChatProvider only' };
  }
  return {
    outcome: `raw ${error instanceof Error ? error.name : typeof error} (escaped EVERYTHING)`,
    wrappedBy: 'none',
  };
}

function report(probe: string, outcome: string, wrappedBy: string): void {
  reports.push({ probe, outcome, wrappedBy });
  console.log(`[probe] ${probe.padEnd(30)} -> ${outcome}`);
}

// --- part 2 main ------------------------------------------------------------

async function probeBoundaries(): Promise<void> {
  console.log('\n=== part 2: deterministic boundary probes (local stub) ===');
  let handler: StubHandler = () => {
    throw new Error('no handler set');
  };
  let requestCount = 0;
  let lastAuth: string | null | undefined;
  let lastRequestBody: unknown;

  const server = createServer((req, res) => {
    requestCount += 1;
    lastAuth = req.headers.authorization;
    // Drain (and capture) the request body before answering so the SDK never
    // sees a reset — tool-call probes assert on the captured wire JSON.
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        lastRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        lastRequestBody = undefined;
      }
      handler(req, res);
    });
  });
  // Read through functions so TS literal narrowing on the counters does not
  // leak across probes (assert() guards narrow `number` to a literal).
  const requests = (): number => requestCount;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  const registry = new ProtocolAdapterRegistry();
  const makeRequester = (authProvider: AuthProvider, url = baseUrl): ModelRequester => {
    const model: Model = {
      id: 'probe',
      name: 'probe-model',
      aliases: [],
      protocol: 'openai',
      baseUrl: url,
      headers: {},
      capabilities: { ...UNKNOWN_CAPABILITY, max_context_tokens: 8192 },
      maxContextSize: 8192,
      alwaysThinking: false,
      providerName: 'probe',
      authProvider,
    };
    return new ModelRequesterImpl(model, registry);
  };
  const staticKey = (apiKey: string): AuthProvider => ({
    canRefresh: false,
    getAuth: () => Promise.resolve({ apiKey }),
  });
  const resetCounts = (): void => {
    requestCount = 0;
    lastAuth = undefined;
  };

  try {
    // 1) happy path — the requester's event envelope on top of the raw stream.
    resetCounts();
    handler = (_req, res) => writePong(res);
    const ok = await collect(makeRequester(staticKey('sk-probe')));
    assert(ok.text === 'pong', 'happy path assembles streamed text');
    assert(ok.events.includes('usage'), 'happy path emits a usage event');
    assert(ok.events.includes('finish'), 'happy path emits a finish event');
    assert(ok.events.includes('timing'), 'happy path emits a timing event');
    assert(lastAuth === 'Bearer sk-probe', 'requester injects per-request auth');
    report('happy-path', `events=${ok.events.join('>')} text=${JSON.stringify(ok.text)}`, '—');

    // 2) 401 with a static key: ChatProvider wraps to APIStatusError(401), the
    // requester translates to provider.auth_error. No replay (canRefresh=false).
    resetCounts();
    handler = (_req, res) => writeJsonError(res, 401, 'invalid api key');
    try {
      await collect(makeRequester(staticKey('sk-bad')));
      throw new Error('expected a failure');
    } catch (error) {
      const { outcome, wrappedBy } = describeCaught(error);
      assert(isError2(error) && error.code === 'provider.auth_error', 'static 401 -> provider.auth_error');
      assert(chatProviderCause(error.cause) instanceof APIStatusError, 'static 401 wrapped as APIStatusError');
      assert(requests() === 1, 'static 401 is NOT replayed');
      report('auth-401-static-key', outcome, wrappedBy);
    }

    // 3) 401 with a refreshable auth provider: the requester force-refreshes
    // and replays ONCE — behavior the ChatProvider layer cannot own.
    resetCounts();
    handler = (req, res) => {
      if (req.headers.authorization === 'Bearer sk-good') writePong(res);
      else writeJsonError(res, 401, 'token expired');
    };
    let getAuthCalls = 0;
    const refreshable: AuthProvider = {
      canRefresh: true,
      getAuth: (options) => {
        getAuthCalls += 1;
        return Promise.resolve({ apiKey: options?.force === true ? 'sk-good' : 'sk-stale' });
      },
    };
    const replayed = await collect(makeRequester(refreshable));
    assert(replayed.text === 'pong', 'refresh+replay succeeds');
    assert(getAuthCalls === 2, 'getAuth called twice (normal + forced)');
    assert(requests() === 2, 'exactly one replay after the 401');
    report('auth-401-refresh-replay', `success after ${String(requestCount)} attempts`, 'ModelRequester ONLY (ChatProvider just throws the 401)');

    // 4) 401 that survives a forced refresh: the provider rejected the account
    // — surfaced as provider.auth_error, not a re-login prompt.
    resetCounts();
    handler = (_req, res) => writeJsonError(res, 401, 'account disabled');
    try {
      await collect(makeRequester(refreshable));
      throw new Error('expected a failure');
    } catch (error) {
      const { outcome, wrappedBy } = describeCaught(error);
      assert(isError2(error) && error.code === 'provider.auth_error', 'post-refresh 401 -> provider.auth_error');
      assert(requests() === 2, 'exactly one replay before surfacing');
      report('auth-401-refresh-rejected', outcome, wrappedBy);
    }

    // 5) 429 with Retry-After: typed rate-limit error carrying the server backoff.
    resetCounts();
    handler = (_req, res) => writeJsonError(res, 429, 'too many requests', { 'retry-after': '2' });
    try {
      await collect(makeRequester(staticKey('sk-probe')));
      throw new Error('expected a failure');
    } catch (error) {
      const { outcome, wrappedBy } = describeCaught(error);
      assert(isError2(error) && error.code === 'provider.rate_limit', '429 -> provider.rate_limit');
      const cause = chatProviderCause(error.cause);
      assert(cause instanceof APIStatusError && cause.retryAfterMs === 2000, 'retry-after parsed to ms');
      report('rate-limit-429', outcome, wrappedBy);
    }

    // 6) 400 context overflow: routed to its own recovery-owned code.
    resetCounts();
    handler = (_req, res) =>
      writeJsonError(res, 400, 'This model\'s maximum context length is 8192 tokens.');
    try {
      await collect(makeRequester(staticKey('sk-probe')));
      throw new Error('expected a failure');
    } catch (error) {
      const { outcome, wrappedBy } = describeCaught(error);
      assert(isError2(error) && error.code === 'context.overflow', '400 overflow -> context.overflow');
      assert(chatProviderCause(error.cause) instanceof APIContextOverflowError, 'overflow typed at the ChatProvider layer');
      report('context-overflow-400', outcome, wrappedBy);
    }

    // 7) 500 with an HTML error page: status error with a sanitized message.
    resetCounts();
    handler = (_req, res) => {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<html><head><title>500 Internal Server Error</title></head><body>oops</body></html>');
    };
    try {
      await collect(makeRequester(staticKey('sk-probe')));
      throw new Error('expected a failure');
    } catch (error) {
      const { outcome, wrappedBy } = describeCaught(error);
      assert(isError2(error) && error.code === 'provider.api_error', '500 -> provider.api_error');
      assert(!error.message.includes('<'), 'HTML body sanitized to its <title>');
      report('server-500-html', outcome, wrappedBy);
    }

    // 8) connection refused: transport failure wrapped as APIConnectionError.
    resetCounts();
    const dead = createServer();
    await new Promise<void>((resolve) => {
    dead.listen(0, '127.0.0.1', () => resolve());
  });
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
    dead.close(() => resolve());
  });
    handler = (_req, res) => writePong(res); // unused — nothing listens there
    try {
      await collect(makeRequester(staticKey('sk-probe'), `http://127.0.0.1:${String(deadPort)}`));
      throw new Error('expected a failure');
    } catch (error) {
      const { outcome, wrappedBy } = describeCaught(error);
      assert(isError2(error) && error.code === 'provider.connection_error', 'refused -> provider.connection_error');
      report('connection-refused', outcome, wrappedBy);
    }

    // 9) empty stream (immediate [DONE]): generate() throws APIEmptyResponseError.
    resetCounts();
    handler = (_req, res) => writeSse(res, []);
    try {
      await collect(makeRequester(staticKey('sk-probe')));
      throw new Error('expected a failure');
    } catch (error) {
      const { outcome, wrappedBy } = describeCaught(error);
      assert(isError2(error) && error.code === 'provider.api_error', 'empty stream -> provider.api_error');
      report('empty-stream-done', outcome, wrappedBy);
    }

    // 10) malformed SSE chunk: who catches a wire-format violation? Reported,
    // not hard-coded — the CODE tells whether ChatProvider wrapped it.
    resetCounts();
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {this is not json}\n\ndata: [DONE]\n\n');
    };
    try {
      await collect(makeRequester(staticKey('sk-probe')));
      throw new Error('expected a failure');
    } catch (error) {
      const { outcome, wrappedBy } = describeCaught(error);
      assert(isError2(error), 'malformed stream still surfaces as a coded Error2');
      report('malformed-sse-chunk', outcome, wrappedBy);
    }

    // 11) stream cut mid-flight: one valid chunk, then the socket dies.
    resetCounts();
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${sseChunk({ role: 'assistant' }, null)}\n\n`, () => {
        res.socket?.destroy();
      });
    };
    try {
      await collect(makeRequester(staticKey('sk-probe')));
      throw new Error('expected a failure');
    } catch (error) {
      const { outcome, wrappedBy } = describeCaught(error);
      assert(isError2(error), 'cut stream still surfaces as a coded Error2');
      report('stream-cut-mid-flight', outcome, wrappedBy);
    }

    // --- tool-call boundary probes -------------------------------------------
    // Response side: streamed `delta.tool_calls` fragments are buffered per
    // index by the OpenAI base and routed into `message.toolCalls` by the
    // contract's generate() driver — both BELOW the ModelRequester, which just
    // forwards the parts. Request side: tool declarations and tool-result
    // history are encoded by the ChatProvider.

    // 12) tool call happy path: header chunk + fragmented arguments, and the
    // outbound request carries the tool declaration.
    resetCounts();
    handler = (_req, res) =>
      writeSse(res, [
        sseToolDelta([
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '' },
          },
        ]),
        sseToolDelta([{ index: 0, function: { arguments: '{"location":"' } }]),
        sseToolDelta([{ index: 0, function: { arguments: 'Hangzhou"}' } }]),
        sseToolDelta([], 'tool_calls'),
        SSE_USAGE,
      ]);
    const toolOk = await collect(makeRequester(staticKey('sk-probe')), undefined, TOOL_INPUT);
    const wireTools = (lastRequestBody as { tools?: { function?: { name?: string } }[] }).tools;
    assert(
      wireTools?.some((t) => t.function?.name === 'get_weather') === true,
      'request encodes the tool declaration',
    );
    assert(toolOk.events.includes('part:function'), 'function header part streamed');
    assert(toolOk.events.includes('part:tool_call_part'), 'argument fragments streamed');
    assert(toolOk.toolCalls.length === 1, 'one assembled tool call');
    assert(toolOk.toolCalls[0]?.name === 'get_weather', 'tool call name assembled');
    assert(
      toolOk.toolCalls[0]?.arguments === '{"location":"Hangzhou"}',
      `fragmented arguments reassembled in order (got ${JSON.stringify(toolOk.toolCalls[0]?.arguments)})`,
    );
    assert(toolOk.finishReason === 'tool_calls', "finish reason 'tool_calls' normalized");
    report(
      'toolcall-happy',
      `toolCalls=[${toolOk.toolCalls[0]?.name}(${toolOk.toolCalls[0]?.arguments ?? ''})] finish=${String(toolOk.finishReason)}`,
      'ChatProvider (decode) + generate() (assembly), below the requester',
    );

    // 13) parallel tool calls with interleaved argument fragments: per-index
    // buffering must keep the two calls apart.
    resetCounts();
    handler = (_req, res) =>
      writeSse(res, [
        sseToolDelta([
          { index: 0, id: 'call_a', type: 'function', function: { name: 'tool_a', arguments: '' } },
        ]),
        sseToolDelta([
          { index: 1, id: 'call_b', type: 'function', function: { name: 'tool_b', arguments: '' } },
        ]),
        sseToolDelta([{ index: 0, function: { arguments: '{"a":' } }]),
        sseToolDelta([{ index: 1, function: { arguments: '{"b":' } }]),
        sseToolDelta([{ index: 0, function: { arguments: '1}' } }]),
        sseToolDelta([{ index: 1, function: { arguments: '2}' } }]),
        sseToolDelta([], 'tool_calls'),
        SSE_USAGE,
      ]);
    const parallel = await collect(makeRequester(staticKey('sk-probe')), undefined, TOOL_INPUT);
    assert(parallel.toolCalls.length === 2, 'two parallel tool calls assembled');
    assert(
      parallel.toolCalls[0]?.name === 'tool_a' && parallel.toolCalls[0]?.arguments === '{"a":1}',
      'index 0 arguments routed to tool_a',
    );
    assert(
      parallel.toolCalls[1]?.name === 'tool_b' && parallel.toolCalls[1]?.arguments === '{"b":2}',
      'index 1 arguments routed to tool_b',
    );
    report(
      'toolcall-parallel-interleaved',
      `toolCalls=[${parallel.toolCalls.map((t) => `${t.name}(${t.arguments ?? ''})`).join(', ')}]`,
      'generate() index routing — interleaving stays separated',
    );

    // 14) malformed tool-call arguments: the wire layer NEVER parses the
    // arguments string — invalid JSON sails through both layers and only fails
    // later at tool dispatch. A boundary neither layer owns, by design.
    resetCounts();
    handler = (_req, res) =>
      writeSse(res, [
        sseToolDelta([
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '' },
          },
        ]),
        sseToolDelta([{ index: 0, function: { arguments: '{not json' } }]),
        sseToolDelta([], 'tool_calls'),
        SSE_USAGE,
      ]);
    const malformedArgs = await collect(makeRequester(staticKey('sk-probe')), undefined, TOOL_INPUT);
    assert(
      malformedArgs.toolCalls[0]?.arguments === '{not json',
      'malformed arguments pass through untouched',
    );
    report(
      'toolcall-malformed-arguments',
      `success, arguments=${JSON.stringify(malformedArgs.toolCalls[0]?.arguments)} preserved verbatim`,
      'neither — arguments validity is deferred to tool dispatch (by design)',
    );

    // 15) index-less fragments: a single call without `index` still assembles
    // (header + trailing merge in generate()). Caveat NOT probed: two
    // interleaved index-less calls would silently cross-merge — the wire layer
    // trusts the provider's indices and does not guard that.
    resetCounts();
    handler = (_req, res) =>
      writeSse(res, [
        sseToolDelta([
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } },
        ]),
        sseToolDelta([{ function: { arguments: '{"location":"HZ"}' } }]),
        sseToolDelta([], 'tool_calls'),
        SSE_USAGE,
      ]);
    const indexless = await collect(makeRequester(staticKey('sk-probe')), undefined, TOOL_INPUT);
    assert(
      indexless.toolCalls[0]?.arguments === '{"location":"HZ"}',
      'index-less fragments merge into the pending call',
    );
    report(
      'toolcall-indexless-fragments',
      `success, arguments=${indexless.toolCalls[0]?.arguments ?? ''}`,
      'generate() pending-part merge (indices trusted, not guarded)',
    );

    // 16) tool-exchange adjacency rejection: the strict-provider 400 must stay
    // recognizable as `isToolExchangeAdjacencyError` THROUGH the ChatProvider
    // wrap — the agent loop's strict-resend recovery keys on that predicate.
    resetCounts();
    handler = (_req, res) =>
      writeJsonError(res, 400, 'tool_call_id "call_1" is not found');
    try {
      await collect(makeRequester(staticKey('sk-probe')), undefined, TOOL_HISTORY_INPUT);
      throw new Error('expected a failure');
    } catch (error) {
      const { outcome, wrappedBy } = describeCaught(error);
      assert(isError2(error) && error.code === 'provider.api_error', 'adjacency 400 -> provider.api_error');
      assert(
        isToolExchangeAdjacencyError(chatProviderCause(error.cause)),
        'adjacency classification survives the ChatProvider wrap',
      );
      report('toolcall-adjacency-400', outcome, wrappedBy);
    }

    // 17) request-side encoding of a tool exchange: assistant tool_calls and
    // the tool result must hit the wire in the provider's shape.
    resetCounts();
    handler = (_req, res) => writePong(res);
    await collect(makeRequester(staticKey('sk-probe')), undefined, TOOL_HISTORY_INPUT);
    const wireMessages = (lastRequestBody as { messages?: Record<string, unknown>[] }).messages;
    assert(
      wireMessages?.some(
        (m) => m['role'] === 'assistant' && Array.isArray(m['tool_calls']),
      ) === true,
      'assistant message carries wire tool_calls',
    );
    assert(
      wireMessages?.some((m) => m['role'] === 'tool' && m['tool_call_id'] === 'call_1') === true,
      'tool result encoded as role=tool with tool_call_id',
    );
    report(
      'toolcall-request-encoding',
      'assistant.tool_calls + role=tool/tool_call_id on the wire',
      'ChatProvider (request-side encoding boundary)',
    );

    // 18) user cancellation: the one boundary BOTH layers pass through.
    resetCounts();
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${sseChunk({ role: 'assistant' }, null)}\n\n`);
      const timer = setInterval(() => {
        res.write(`data: ${sseChunk({ content: '.' }, null)}\n\n`);
      }, 25);
      res.on('close', () => clearInterval(timer));
    };
    const ac = new AbortController();
    try {
      for await (const event of makeRequester(staticKey('sk-probe')).request(PING_INPUT, ac.signal)) {
        if (event.type === 'part') ac.abort();
      }
      throw new Error('expected an abort');
    } catch (error) {
      const { outcome, wrappedBy } = describeCaught(error);
      assert(isAbortError(error), 'abort surfaces as the standard AbortError');
      assert(!isError2(error), 'abort is NOT translated into an Error2');
      assert(!(error instanceof ChatProviderError), 'abort is NOT a ChatProviderError');
      report('abort-mid-stream', outcome, wrappedBy);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  }

  console.log('\n=== boundary matrix ===');
  for (const r of reports) {
    console.log(`${r.probe.padEnd(30)} ${r.outcome}`);
    console.log(`${''.padEnd(30)} └ ${r.wrappedBy}`);
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env['KIMI_BOUNDARY_SKIP_LIVE'] !== '1') {
    await probeRealConfig();
  }
  await probeBoundaries();
  console.log('\nboundary: OK');
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
