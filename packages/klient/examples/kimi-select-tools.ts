/**
 * Probe the `select_tools` (progressive tool disclosure) capability of the
 * kimi-type providers, based on the real providers/auth in
 * `~/.kimi-code/config.toml`.
 *
 * Feature recap (from the Tool Select guide): with the `tool-select`
 * experimental flag + `tool_use` + `dynamically_loaded_tools` capabilities,
 * MCP tool schemas no longer ride the top-level `tools[]`; the model calls
 * the builtin `select_tools` with exact names (announced in
 * `<tools_added>`/`<tools_removed>` system reminders), the engine injects
 * the loaded schemas as a `role: 'system'` message whose `tools` field
 * carries full definitions, and the model then calls the loaded tool.
 *
 * The wire fact that makes this kimi-specific: only the kimi vendor trait
 * serializes `message.tools` into the outbound request
 * (`kimiOpenAITrait.convertMessage`); every other base SKIPS
 * tool-declaration-only messages entirely. So the whole mechanism can only
 * work on `(kimi, openai)` — this example proves that on a stub, then
 * behaviorally tests each real kimi model with a simulated "kimi computer
 * use" tool pool.
 *
 * Part A — deterministic, local stub (OpenAI Chat Completions wire):
 *   1. kimi providerType: the tool-declaration message reaches the wire with
 *      an embedded `tools` array.
 *   2. no providerType (plain openai): the same message is dropped — the
 *      boundary non-kimi providers cannot cross.
 *   3. `deferred: true` top-level tools are filtered out of the wire
 *      `tools[]` by the contract's generate() (their schema travels via the
 *      declaration message instead).
 *
 * Part B — live, per kimi model from the real config: a two-step flow that
 * mirrors exactly what the agent loop produces.
 *   step 1: announcement + `select_tools` available, user asks for a
 *           screenshot — does the model call `select_tools`, with names from
 *           the announced list?
 *   step 2: history += the select_tools call, its "Loaded: ..." result, and
 *           the schema-injection system message — does the model now call
 *           the loaded computer-use tool?
 *
 * Run:
 *   pnpm -C packages/klient exec tsx --tsconfig ./tsconfig.examples.json \
 *     --import ../../build/register-raw-text-loader.mjs examples/kimi-select-tools.ts
 *
 * Env:
 *   KIMI_CODE_HOME              — default `~/.kimi-code`
 *   KIMI_SELECT_TOOLS_MODELS    — comma-separated model ids for the live parts (default: all kimi-type)
 *   KIMI_SELECT_TOOLS_SKIP_LIVE — set to `1` to skip part B (no real API calls)
 *   KIMI_SELECT_TOOLS_TAP       — set to `1` to run part C instead of B: route
 *                                 the flow through a logging proxy and dump
 *                                 the actual wire Context of each request.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { renderLoadableToolsAnnouncement } from '@moonshot-ai/agent-core-v2/agent/toolSelect/dynamicTools';
import { UNKNOWN_CAPABILITY } from '@moonshot-ai/agent-core-v2/kosong/contract/capability';
import type { Message } from '@moonshot-ai/agent-core-v2/kosong/contract/message';
import type { Tool } from '@moonshot-ai/agent-core-v2/kosong/contract/tool';
import type { AuthProvider, Model } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import type {
  ModelRequestInput,
  ModelRequester,
} from '@moonshot-ai/agent-core-v2/kosong/model/modelRequester';
import { ModelRequesterImpl } from '@moonshot-ai/agent-core-v2/kosong/model/modelRequesterImpl';
import { IProtocolAdapterRegistry } from '@moonshot-ai/agent-core-v2/kosong/protocol/protocol';
import { ProtocolAdapterRegistry } from '@moonshot-ai/agent-core-v2/kosong/provider/protocolAdapterRegistry';

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// The simulated "kimi computer use" MCP tool pool.
// ---------------------------------------------------------------------------

const COMPUTER_USE_TOOLS: readonly Tool[] = [
  {
    name: 'computer_screenshot',
    description: 'Take a screenshot of the current screen and return it as an image.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'computer_click',
    description: 'Click at a screen coordinate.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Screen x coordinate.' },
        y: { type: 'number', description: 'Screen y coordinate.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_move',
    description: 'Move the mouse to a screen coordinate.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_type',
    description: 'Type text at the current focus.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_scroll',
    description: 'Scroll at a screen coordinate.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        delta_y: { type: 'number' },
      },
      required: ['x', 'y', 'delta_y'],
      additionalProperties: false,
    },
  },
];

const COMPUTER_USE_NAMES = COMPUTER_USE_TOOLS.map((t) => t.name);

/** The builtin select_tools schema, mirroring `SelectToolsInputSchema`. */
const SELECT_TOOLS: Tool = {
  name: 'select_tools',
  description:
    'Load one or more tools by name so you can call them. ' +
    'All available tool names are listed in the <tools_added>/<tools_removed> announcements ' +
    'in the system context — fold them in order to get the current list. ' +
    'Pass the exact name(s) you need; their full definitions become available immediately, ' +
    'so you can call them directly in your next tool call.',
  parameters: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Exact tool names to load, taken from the latest announced tool list.',
      },
    },
    required: ['names'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT =
  'You are a computer-use agent operating the user\u2019s computer through tool calls. ' +
  'Only a core tool set is available up front; additional tools are announced by name in ' +
  '<tools_added> blocks in the system context. To use an announced tool, first call ' +
  'select_tools with its exact name to load its definition, then call the tool itself.';

const userMessage = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
  toolCalls: [],
});

/** The schema-injection message the engine appends after a successful load. */
const toolDeclarationMessage = (tools: readonly Tool[]): Message => ({
  role: 'system',
  content: [],
  toolCalls: [],
  tools,
});

const announcementMessage = (names: readonly string[]): Message => ({
  role: 'system',
  content: [
    { type: 'text', text: renderLoadableToolsAnnouncement(names, []) },
  ],
  toolCalls: [],
});

// ---------------------------------------------------------------------------
// Shared request draining.
// ---------------------------------------------------------------------------

interface Collected {
  readonly text: string;
  readonly toolCalls: readonly { id: string; name: string; arguments: string | null }[];
  readonly finishReason?: string | undefined;
}

async function collect(
  requester: ModelRequester,
  input: ModelRequestInput,
  signal?: AbortSignal,
): Promise<Collected> {
  let text = '';
  let toolCalls: Collected['toolCalls'] = [];
  let finishReason: string | undefined;
  for await (const event of requester.request(input, signal)) {
    if (event.type === 'part' && event.part.type === 'text') text += event.part.text;
    if (event.type === 'finish') {
      finishReason = event.providerFinishReason ?? event.rawFinishReason;
      toolCalls = event.message.toolCalls.map((t) => ({
        id: t.id,
        name: t.name,
        arguments: t.arguments,
      }));
    }
  }
  return { text, toolCalls, finishReason };
}

// ---------------------------------------------------------------------------
// Part A — deterministic wire-encoding probes against a local stub.
// ---------------------------------------------------------------------------

const sseChunk = (delta: object, finishReason: string | null): string =>
  JSON.stringify({
    id: 'chatcmpl-probe',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'probe-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

function writePong(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${sseChunk({ role: 'assistant' }, null)}\n\n`);
  res.write(`data: ${sseChunk({ content: 'pong' }, null)}\n\n`);
  res.write(`data: ${sseChunk({}, 'stop')}\n\n`);
  res.end('data: [DONE]\n\n');
}

interface WireMessage {
  readonly role?: string;
  readonly tools?: readonly { function?: { name?: string } }[];
}

interface WireBody {
  readonly messages?: readonly WireMessage[];
  readonly tools?: readonly { function?: { name?: string } }[];
}

async function probeWireEncoding(): Promise<void> {
  console.log('\n=== part A: wire-encoding boundary (local stub) ===');
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) =>
    writePong(res);
  let lastBody: WireBody | undefined;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireBody;
      } catch {
        lastBody = undefined;
      }
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  const registry = new ProtocolAdapterRegistry();
  const staticKey: AuthProvider = {
    canRefresh: false,
    getAuth: () => Promise.resolve({ apiKey: 'sk-probe' }),
  };
  const makeRequester = (providerType?: string): ModelRequester => {
    const model: Model = {
      id: 'probe',
      name: 'probe-model',
      aliases: [],
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${String(port)}`,
      headers: {},
      capabilities: { ...UNKNOWN_CAPABILITY, max_context_tokens: 8192 },
      maxContextSize: 8192,
      alwaysThinking: false,
      providerType,
      providerName: providerType ?? 'probe',
      authProvider: staticKey,
    };
    return new ModelRequesterImpl(model, registry);
  };

  const input: ModelRequestInput = {
    systemPrompt: SYSTEM_PROMPT,
    tools: [SELECT_TOOLS, { ...COMPUTER_USE_TOOLS[0]!, deferred: true }],
    messages: [
      announcementMessage(COMPUTER_USE_NAMES),
      userMessage('take a screenshot'),
      toolDeclarationMessage([COMPUTER_USE_TOOLS[0]!]),
    ],
  };

  try {
    // 1) kimi providerType: the declaration message reaches the wire, with the
    // loaded schema embedded in the message — and the deferred top-level tool
    // does NOT duplicate into the wire tools[].
    await collect(makeRequester('kimi'), input);
    const kimiBody = lastBody;
    const declaration = kimiBody?.messages?.find((m) => Array.isArray(m.tools));
    assert(declaration !== undefined, 'kimi: a wire message carries the loaded tool schemas');
    assert(
      declaration.tools?.some((t) => t.function?.name === 'computer_screenshot') === true,
      'kimi: declaration embeds computer_screenshot',
    );
    assert(
      kimiBody?.tools?.some((t) => t.function?.name === 'select_tools') === true,
      'kimi: top-level tools[] keeps select_tools',
    );
    assert(
      kimiBody?.tools?.some((t) => t.function?.name === 'computer_screenshot') !== true,
      'kimi: deferred tool stays OUT of top-level tools[]',
    );
    console.log(
      `[ok] kimi: declaration on wire (role=${String(declaration.role)}), ` +
        `top-level tools=[${(kimiBody?.tools ?? []).map((t) => t.function?.name ?? '?').join(', ')}]`,
    );

    // 2) plain openai: the same declaration message is dropped outright — the
    // dynamic-tool schema can never reach a non-kimi wire. (3 wire messages =
    // system prompt + announcement + user; the declaration is gone.)
    await collect(makeRequester(), input);
    const plainBody = lastBody;
    assert(
      plainBody?.messages?.every((m) => !Array.isArray(m.tools)) === true,
      'openai: declaration message dropped (no wire message carries tools)',
    );
    assert(
      plainBody?.messages?.length === 3,
      `openai: declaration removed from history (got ${String(plainBody?.messages?.length)} messages)`,
    );
    console.log(
      '[ok] openai: declaration message dropped — dynamic tools cannot cross a non-kimi wire',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

// ---------------------------------------------------------------------------
// Part B — live two-step select_tools flow per real kimi model.
// ---------------------------------------------------------------------------

type Step1Outcome =
  | { readonly kind: 'selected'; readonly names: readonly string[]; readonly callId: string; readonly argumentsJson: string }
  | { readonly kind: 'no-call'; readonly text: string }
  | { readonly kind: 'error'; readonly message: string };

type Step2Outcome =
  | { readonly kind: 'called'; readonly name: string; readonly argumentsJson: string | null }
  | { readonly kind: 'other'; readonly description: string }
  | { readonly kind: 'error'; readonly message: string };

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(ms)}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface Scenario {
  readonly prompt: string;
  /** The tool a correct model is expected to select and call. */
  readonly expectTool: string;
}

const SCENARIOS: readonly Scenario[] = [
  { prompt: 'Take a screenshot of my screen right now.', expectTool: 'computer_screenshot' },
  {
    prompt: 'Click at the exact center of my screen. The screen resolution is 1920x1080.',
    expectTool: 'computer_click',
  },
];

async function step1Select(requester: ModelRequester, scenario: Scenario): Promise<Step1Outcome> {
  try {
    const result = await withTimeout(
      collect(requester, {
        systemPrompt: SYSTEM_PROMPT,
        tools: [SELECT_TOOLS],
        messages: [
          announcementMessage(COMPUTER_USE_NAMES),
          userMessage(scenario.prompt),
        ],
      }),
      60_000,
      'step1',
    );
    const call = result.toolCalls.find((t) => t.name === 'select_tools');
    if (call === undefined) {
      const other = result.toolCalls.map((t) => t.name).join(', ');
      return {
        kind: 'no-call',
        text:
          result.toolCalls.length > 0
            ? `called [${other}] instead`
            : `answered text: ${result.text.slice(0, 80)}`,
      };
    }
    let names: string[] = [];
    try {
      const parsed = JSON.parse(call.arguments ?? '{}') as { names?: unknown };
      if (Array.isArray(parsed.names)) names = parsed.names.filter((n): n is string => typeof n === 'string');
    } catch {
      // keep names empty — reported below
    }
    return { kind: 'selected', names, callId: call.id, argumentsJson: call.arguments ?? '' };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error) };
  }
}

async function step2UseLoadedTool(
  requester: ModelRequester,
  step1: Extract<Step1Outcome, { kind: 'selected' }>,
  scenario: Scenario,
): Promise<Step2Outcome> {
  const validNames = step1.names.filter((n) => COMPUTER_USE_NAMES.includes(n));
  const loadName = validNames.includes(scenario.expectTool)
    ? scenario.expectTool
    : validNames[0];
  if (loadName === undefined) {
    return { kind: 'other', description: `selected names not in announced list: [${step1.names.join(', ')}]` };
  }
  const loadedTool = COMPUTER_USE_TOOLS.find((t) => t.name === loadName)!;
  const messages = (withDeclaration: boolean): ModelRequestInput => ({
    systemPrompt: SYSTEM_PROMPT,
    tools: [SELECT_TOOLS, { ...loadedTool, deferred: true }],
    messages: [
      announcementMessage(COMPUTER_USE_NAMES),
      userMessage(scenario.prompt),
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          {
            type: 'function',
            id: step1.callId,
            name: 'select_tools',
            arguments: JSON.stringify({ names: [loadName] }),
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: step1.callId,
        content: [{ type: 'text', text: `Loaded: ${loadName}` }],
        toolCalls: [],
      },
      // The schema-injection message — the exact wire shape whose acceptance
      // this probe measures. Dropped entirely in the isolation retry below.
      ...(withDeclaration ? [toolDeclarationMessage([loadedTool])] : []),
    ],
  });
  try {
    const result = await withTimeout(collect(requester, messages(true)), 60_000, 'step2');
    const call = result.toolCalls.find((t) => t.name === loadName);
    if (call !== undefined) {
      return { kind: 'called', name: call.name, argumentsJson: call.arguments };
    }
    const other = result.toolCalls.map((t) => t.name).join(', ');
    return {
      kind: 'other',
      description:
        result.toolCalls.length > 0
          ? `called [${other}] instead of ${loadName}`
          : `answered text: ${result.text.slice(0, 80)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
    // Differential: retry the SAME request minus the schema-injection message.
    // If it then succeeds, the backend rejects the dynamic-schema wire shape
    // specifically; if it fails too, the problem is elsewhere in the flow.
    try {
      await withTimeout(collect(requester, messages(false)), 60_000, 'step2-isolation');
      return {
        kind: 'error',
        message: `${message} (isolation: same request WITHOUT the tools-in-message injection succeeds — backend rejects the dynamic-schema wire shape)`,
      };
    } catch {
      return { kind: 'error', message: `${message} (isolation: also fails without the injection — not caused by the declaration message)` };
    }
  }
}

async function probeLiveKimiProviders(): Promise<void> {
  const homeDir = process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
  console.log(`\n=== part B: live select_tools flow on real kimi providers (${homeDir}) ===`);
  const { app } = bootstrap({ homeDir }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]);
  try {
    await app.accessor.get(IConfigService).ready;
    const catalog = app.accessor.get(IModelCatalog);

    const filter = process.env['KIMI_SELECT_TOOLS_MODELS']?.split(',').map((s) => s.trim());
    const models = await catalog.listModels();
    const targets = models.filter((m) => {
      if (filter !== undefined && !filter.includes(m.model)) return false;
      try {
        return catalog.get(m.model).providerType === 'kimi';
      } catch {
        return false;
      }
    });
    assert(targets.length > 0, 'at least one kimi-type model configured');

    const summary: string[] = [];
    for (const m of targets) {
      const model = catalog.get(m.model);
      const declared = model.capabilities.dynamically_loaded_tools === true;
      const requester = catalog.getRequester(m.model);

      for (const scenario of SCENARIOS) {
        const startedAt = Date.now();
        const step1 = await step1Select(requester, scenario);
        let row: string;
        if (step1.kind === 'selected') {
          const step2 = await step2UseLoadedTool(requester, step1, scenario);
          const elapsed = `${String(Date.now() - startedAt)}ms`;
          if (step2.kind === 'called') {
            row = `PASS  select=[${step1.names.join(', ')}] then called ${step2.name}(${step2.argumentsJson ?? ''})`;
          } else if (step2.kind === 'other') {
            row = `PARTIAL  select=[${step1.names.join(', ')}] but step2: ${step2.description}`;
          } else {
            row = `PARTIAL  select=[${step1.names.join(', ')}] but step2 error: ${step2.message}`;
          }
          console.log(`[${m.model}] ${scenario.expectTool}  ${elapsed}  declared=${String(declared)}  ${row}`);
        } else if (step1.kind === 'no-call') {
          row = `FAIL  no select_tools call: ${step1.text}`;
          console.log(`[${m.model}] ${scenario.expectTool}  ${String(Date.now() - startedAt)}ms  declared=${String(declared)}  ${row}`);
        } else {
          row = `ERROR  ${step1.message}`;
          console.log(`[${m.model}] ${scenario.expectTool}  ${String(Date.now() - startedAt)}ms  declared=${String(declared)}  ${row}`);
        }
        summary.push(`${m.model.padEnd(40)} ${scenario.expectTool.padEnd(22)} ${row}`);
      }
    }

    console.log('\n=== live summary (declared = config declares dynamically_loaded_tools) ===');
    for (const line of summary) console.log(line);
  } finally {
    app.dispose();
  }
}

// ---------------------------------------------------------------------------
// Part C — TAP mode: sit a logging proxy between the requester and the real
// endpoint, and dump the actual wire Context (structure digest only — auth
// headers are forwarded untouched, never printed).
// ---------------------------------------------------------------------------

interface TapWireTool {
  readonly type?: string;
  readonly function?: { readonly name?: string };
}

interface TapWireMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly tools?: readonly TapWireTool[];
  readonly tool_calls?: readonly { readonly function?: { readonly name?: string } }[];
  readonly tool_call_id?: string;
}

function describeWireBody(raw: Buffer): string[] {
  const lines: string[] = [];
  let body: { tools?: TapWireTool[]; messages?: TapWireMessage[]; model?: string };
  try {
    body = JSON.parse(raw.toString('utf8')) as typeof body;
  } catch {
    return ['    (unparseable body)'];
  }
  const toolName = (t: TapWireTool): string => t.function?.name ?? t.type ?? '?';
  lines.push(`    model=${String(body.model)}`);
  lines.push(`    top-level tools[] = [${(body.tools ?? []).map(toolName).join(', ')}]`);
  for (const [i, m] of (body.messages ?? []).entries()) {
    const parts: string[] = [`#${String(i)} role=${String(m.role)}`];
    if (Array.isArray(m.tools)) {
      parts.push(`>>> tools=[${m.tools.map(toolName).join(', ')}] (dynamic schema injected HERE)`);
    }
    if (Array.isArray(m.tool_calls)) {
      parts.push(`tool_calls=[${m.tool_calls.map((tc) => tc.function?.name ?? '?').join(', ')}]`);
    }
    if (m.tool_call_id !== undefined) parts.push(`tool_call_id=${m.tool_call_id}`);
    const content =
      typeof m.content === 'string' ? m.content : m.content === undefined ? '' : JSON.stringify(m.content);
    if (content.length > 0) parts.push(`content=${content.slice(0, 60).replaceAll('\n', ' ')}…`);
    lines.push(`    ${parts.join('  ')}`);
  }
  return lines;
}

async function probeTappedContext(): Promise<void> {
  const homeDir = process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
  console.log(`\n=== part C: tapped wire context (${homeDir}) ===`);
  const { app } = bootstrap({ homeDir }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]);
  try {
    await app.accessor.get(IConfigService).ready;
    const catalog = app.accessor.get(IModelCatalog);
    const registry = app.accessor.get(IProtocolAdapterRegistry);

    const filter = process.env['KIMI_SELECT_TOOLS_MODELS']?.split(',').map((s) => s.trim());
    const models = await catalog.listModels();
    const targets = models.filter((m) => {
      if (filter !== undefined && !filter.includes(m.model)) return false;
      try {
        return catalog.get(m.model).providerType === 'kimi';
      } catch {
        return false;
      }
    });
    assert(targets.length > 0, 'at least one kimi-type model configured');

    for (const m of targets) {
      const model = catalog.get(m.model);
      if (model.baseUrl === undefined) {
        console.log(`[${m.model}] skip tap: model has no resolved baseUrl`);
        continue;
      }
      const upstream = model.baseUrl;
      let tapCount = 0;
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          void (async () => {
            const raw = Buffer.concat(chunks);
            tapCount += 1;
            console.log(`\n[${m.model}] ── request #${String(tapCount)} → ${upstream}${req.url ?? ''}`);
            for (const line of describeWireBody(raw)) console.log(line);
            const headers = { ...(req.headers as Record<string, string>) };
            delete headers['host'];
            delete headers['content-length'];
            delete headers['connection'];
            const response = await fetch(`${upstream}${req.url ?? ''}`, {
              method: req.method,
              headers,
              body: raw.length > 0 ? raw : undefined,
            });
            const passthrough: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              if (key !== 'content-length' && key !== 'content-encoding' && key !== 'transfer-encoding') {
                passthrough[key] = value;
              }
            });
            res.writeHead(response.status, passthrough);
            res.end(Buffer.from(await response.arrayBuffer()));
          })().catch((error: unknown) => {
            res.writeHead(502);
            res.end(String(error));
          });
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const port = (server.address() as AddressInfo).port;

      try {
        const tapped = new ModelRequesterImpl(
          { ...model, baseUrl: `http://127.0.0.1:${String(port)}` },
          registry,
        );
        // One scenario is enough to show the mechanism: click (has arguments).
        const scenario = SCENARIOS[1]!;
        const step1 = await step1Select(tapped, scenario);
        if (step1.kind === 'selected') {
          const step2 = await step2UseLoadedTool(tapped, step1, scenario);
          console.log(
            `\n[${m.model}] outcome: select=[${step1.names.join(', ')}] -> ${step2.kind === 'called' ? `called ${step2.name}(${step2.argumentsJson ?? ''})` : JSON.stringify(step2)}`,
          );
        } else {
          console.log(`\n[${m.model}] step1 outcome: ${JSON.stringify(step1)}`);
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    }
  } finally {
    app.dispose();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await probeWireEncoding();
  if (process.env['KIMI_SELECT_TOOLS_TAP'] === '1') {
    await probeTappedContext();
  } else if (process.env['KIMI_SELECT_TOOLS_SKIP_LIVE'] !== '1') {
    await probeLiveKimiProviders();
  }
  console.log('\nselect-tools: OK');
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
