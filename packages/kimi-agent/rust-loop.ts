/// Rust agent engine adapter.
///
/// When `agent.engine = "rust"` is configured, this module provides
/// a drop-in replacement for the JS turn loop. Two transport modes are
/// supported, selected automatically at startup:
///
/// 1. **napi-rs** (preferred): The native `kimi_agent.node` addon is
///    loaded directly into the Node.js process. Host callbacks are
///    invoked as JS functions via ThreadsafeFunction — no serialization
///    overhead and no subprocess management.
/// 2. **stdio JSON-RPC** (fallback): The `kimi-agent-cli` Rust binary
///    is spawned as a child process and communicates via JSON-RPC over
///    stdin/stdout.
///
/// If neither is available, it falls back to the JS implementation.

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// A bare `require` only exists under CJS interop (vitest); in the ESM
// runtimes that actually ship — tsx dev mode and the tsdown bundle — it is a
// ReferenceError, which used to escape `isAvailable()` and silently demote
// every `engine = "rust"` session to the JS engine. createRequire works in
// all of them, and is also what loads the native addon.
const nodeRequire = createRequire(import.meta.url);

import {
  tryNativeWorkspaceIndexPredictRead,
  type NativeReadPrediction,
} from '@moonshot-ai/agent-core-v2';
import {
  APIRequestTooLargeError,
  isImageFormatError,
  isRecoverableRequestStructureError,
} from '@moonshot-ai/kosong';

// Project root: packages/kimi-agent/rust-loop.ts → ../../ (project root)
const projectRoot = resolve(import.meta.dirname, '..', '..');

/** Token usage carried on step.end (structurally matches kosong's TokenUsage). */
interface HostTokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

const ZERO_USAGE: HostTokenUsage = {
  inputOther: 0,
  output: 0,
  inputCacheRead: 0,
  inputCacheCreation: 0,
};

// ── Types matching the Rust agent protocol ─────────────────────────────────

interface RpcMessage {
  jsonrpc: '2.0';
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RunTurnParams {
  turn_id: string;
  system_prompt: string;
  model_name: string;
  messages: { role: string; content: string }[];
  tools: { name: string; description: string; input_schema: unknown }[];
  max_steps?: number;
  /** Multiple LLM providers for concurrent execution (MultiLLM). */
  providers?: LlmProviderDef[];
  /** Optional goal context for budget-aware execution. */
  goal?: GoalContext;
}

/** Goal status matching the Rust GoalStatus enum. */
type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'budgetLimited' | 'usageLimited';

/** Goal context passed to the Rust engine for budget-aware turns. */
interface GoalContext {
  goal_id: string;
  objective: string;
  status: GoalStatus;
  token_budget?: number;
  turn_budget?: number;
  tokens_used: number;
  turns_used: number;
}

interface LlmProviderDef {
  name: string;
  model: string;
  system_prompt: string;
}

/** Native HTTP LLM transport config (snake_case matches the Rust wire). */
export interface NativeLlmDef {
  /** "openai" (Chat Completions) or "anthropic" (Messages). */
  protocol: 'openai' | 'anthropic';
  /** API base URL including the version segment (e.g. `.../v1`). */
  base_url: string;
  api_key: string;
  model: string;
  max_tokens?: number;
}

/** Options controlling the native (in-Rust) execution paths. */
export interface RustEngineOptions {
  /** When set, the Rust engine calls this provider directly over HTTP. */
  nativeLlm?: NativeLlmDef;
  /** When true, Read/Grep/Glob execute inside the Rust process. */
  nativeTools?: boolean;
}

/** A content block on the Rust wire (see `ContentBlock` in rpc/types.rs). */
type WireContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string }
  | { type: 'image_url'; url: string };

/** Fire-and-forget engine event (Rust → host, `host/event`). */
interface EngineEvent {
  type: string;
  [key: string]: unknown;
}

interface RunTurnResult {
  stop_reason: string;
  steps: number;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

/** A message on the Rust wire, with optional multimodal/tool-call payloads. */
interface WireMessage {
  role: string;
  content: string;
  blocks?: WireContentBlock[];
  tool_calls?: { id: string; name: string; arguments: unknown }[];
  tool_call_id?: string;
}

interface LlmChatRequest {
  system_prompt: string;
  model_name: string;
  messages: { role: string; content: string }[];
  tools: { name: string; description: string; input_schema: unknown }[];
}

interface LlmChatResponse {
  tool_calls: { id: string; name: string; arguments: unknown }[];
  finish_reason?: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

interface ToolExecuteRequest {
  turn_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  /** When true, skip workspace index predictions and execute precisely. */
  force_precise?: boolean;
}

interface ToolExecuteResponse {
  content: string;
  is_error: boolean;
  /** When true, the result is a fast prediction from the workspace index. */
  is_prediction?: boolean;
}

// ── Tool lifecycle hooks (tool_call.rs) ──────────────────────────────────

interface PrepareToolRequest {
  turn_id: string;
  step_number: number;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  all_tool_calls: unknown[];
  trace_id?: string;
}

interface PrepareToolResponse {
  block: boolean;
  reason?: string;
  synthetic_result?: {
    content: string;
    is_error: boolean;
    note?: string;
    is_prediction: boolean;
    stop_turn: boolean;
  };
  updated_args?: unknown;
  execution_metadata?: unknown;
  resolved: boolean;
}

interface AuthorizeToolRequest {
  turn_id: string;
  step_number: number;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  all_tool_calls: unknown[];
  trace_id?: string;
  approval_rule: string;
}

interface AuthorizeToolResponse {
  block: boolean;
  reason?: string;
  synthetic_result?: {
    content: string;
    is_error: boolean;
    note?: string;
    is_prediction: boolean;
    stop_turn: boolean;
  };
  execution_metadata?: unknown;
  resolved: boolean;
}

interface FinalizeToolRequest {
  turn_id: string;
  step_number: number;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  result: {
    content: string;
    is_error: boolean;
    note?: string;
    is_prediction: boolean;
    stop_turn: boolean;
  };
  trace_id?: string;
}

type FinalizeToolResponse = {
  content: string;
  is_error: boolean;
  note?: string;
  is_prediction: boolean;
  stop_turn: boolean;
} | null;

/**
 * Classify an incoming RPC line. A JSON-RPC request always carries `method`; a
 * response never does. Discriminating on `method` FIRST prevents a Rust host
 * request whose id collides with a pending request id from being mis-routed as
 * that request's response (both sides allocate ids from 1).
 */
export function classifyRpcMessage(msg: RpcMessage): 'request' | 'response' | 'ignore' {
  if (msg.method !== undefined) {
    return msg.id !== undefined ? 'request' : 'ignore';
  }
  return msg.id !== undefined ? 'response' : 'ignore';
}

// ── Napi result types (matching Rust JsRunTurnResult) ────────────────────

interface NapiRunTurnResult {
  stopReason: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ── Napi engine (in-process native addon) ─────────────────────────────────

/** Shape of the loaded `kimi_agent.node` native addon. */
interface KimiAgentNativeModule {
  getCallbackPayload(id: number): string | null;
  resolveCallback(id: number, error: string | null, result: string | null): void;
  /** Sets the per-turn cancellation flag; absent in pre-cancel addon builds. */
  cancelTurnRust?(turnId: string): boolean;
  runTurnRust(
    params: unknown,
    llmChatCb: (callbackId: number) => void,
    executeToolCb: (callbackId: number) => void,
    emitEventCb?: (callbackId: number) => void,
    prepareToolCb?: (callbackId: number) => void,
    authorizeToolCb?: (callbackId: number) => void,
    finalizeToolCb?: (callbackId: number) => void,
  ): Promise<NapiRunTurnResult>;
}

class NapiEngine {
  private nativeModule: KimiAgentNativeModule | null = null;
  private loaded = false;

  static findModule(): string | null {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = nodeRequire('node:fs') as typeof import('node:fs');
    const candidates = [
      // Development: alongside rust-loop.ts in the package directory
      resolve(import.meta.dirname, 'kimi_agent.node'),
      // Production: may be bundled elsewhere
      resolve(projectRoot, 'packages/kimi-agent/kimi_agent.node'),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore
      }
    }
    return null;
  }

  static isAvailable(): boolean {
    return NapiEngine.findModule() !== null;
  }

  load(): boolean {
    if (this.loaded) return true;
    const modulePath = NapiEngine.findModule();
    if (!modulePath) {
      console.warn('[kimi-agent] napi module not found');
      return false;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.nativeModule = nodeRequire(modulePath) as KimiAgentNativeModule;
      this.loaded = true;
      return true;
    } catch (error) {
      console.warn('[kimi-agent] Failed to load napi module:', error);
      return false;
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Set the per-turn cancellation flag inside the addon, stopping the turn
   * at its next step boundary. Returns false when the addon predates the
   * cancel export or no turn with this id is running.
   */
  cancelTurn(turnId: string): boolean {
    try {
      return this.nativeModule?.cancelTurnRust?.(turnId) === true;
    } catch {
      return false;
    }
  }

  /**
   * Call the native runTurnRust function.
   *
   * Internally wraps the callbacks to use the **callback registry** pattern:
   * Rust calls `(envelope: string) => void` where envelope is a JSON object
   * `{ id: number, payload: string }`. The wrapper parses the envelope,
   * calls the user's async callback with the payload, then resolves via
   * `resolveCallback(id, err?, result?)`.
   *
   * The two callbacks receive JSON-serialized request payloads and must
   * return JSON-serialized response payloads (or a Promise resolving to one):
   *   - llmChatCb: receives `LlmChatRequest` JSON, returns `LlmChatResponse` JSON
   *   - executeToolCb: receives `ToolExecuteRequest` JSON, returns `ToolExecuteResponse` JSON
   */
  async runTurn(
    params: {
      turnId: string;
      systemPrompt: string;
      modelName: string;
      messages: Array<{
        role: string;
        content: string;
        blocksJson?: string;
        toolCallsJson?: string;
        toolCallId?: string;
      }>;
      tools: Array<{ name: string; description: string; inputSchema: string }>;
      maxSteps?: number;
      goal?: {
        goalId: string;
        objective: string;
        status: string;
        tokenBudget?: number;
        turnBudget?: number;
        tokensUsed: number;
        turnsUsed: number;
      };
      nativeLlm?: {
        protocol: string;
        baseUrl: string;
        apiKey: string;
        model: string;
        maxTokens?: number;
      };
      workspaceRoot?: string;
      nativeTools?: boolean;
    },
    llmChatCb: (request: string) => Promise<string>,
    executeToolCb: (request: string) => Promise<string>,
    emitEventCb?: (event: EngineEvent) => void,
    lifecycleCbs?: {
      /** Each takes the JSON request and returns the JSON response ("null" = no hook decision). */
      prepareTool: (request: string) => Promise<string>;
      authorizeTool: (request: string) => Promise<string>;
      finalizeTool: (request: string) => Promise<string>;
    },
  ): Promise<NapiRunTurnResult> {
    if (!this.nativeModule) {
      throw new Error('Napi module not loaded');
    }

    const nativeModule = this.nativeModule;

    /**
     * Create a callback handler for the native module.
     *
     * The native module passes a `callbackId: number` to the JS callback.
     * The handler fetches the payload via `getCallbackPayload(id)`,
     * calls the user's async handler with the payload, then resolves via
     * `resolveCallback(id, error?, result?)`.
     */
    const makeCallbackHandler = (handler: (request: string) => Promise<string>) => {
      return (callbackId: number) => {
        const payload = nativeModule.getCallbackPayload(callbackId);
        if (!payload) return;
        // Wrap in try/catch: if `handler` (or any sync prologue such as
        // argument parsing) throws synchronously, `.then` would never be
        // registered and `resolveCallback` would never be called, leaving
        // the Rust side waiting on this callback forever (turn deadlock).
        try {
          Promise.resolve(handler(payload)).then(
            (result) => {
              nativeModule.resolveCallback(callbackId, null, result);
            },
            (error: unknown) => {
              nativeModule.resolveCallback(
                callbackId,
                error instanceof Error ? error.message : String(error),
                null,
              );
            },
          );
        } catch (error: unknown) {
          nativeModule.resolveCallback(
            callbackId,
            error instanceof Error ? error.message : String(error),
            null,
          );
        }
      };
    };

    // Fire-and-forget event channel: fetch the payload but never resolve.
    const eventHandler =
      emitEventCb === undefined
        ? undefined
        : (callbackId: number) => {
            const payload = nativeModule.getCallbackPayload(callbackId);
            if (!payload) return;
            try {
              emitEventCb(JSON.parse(payload) as EngineEvent);
            } catch {
              // Malformed events are dropped; they must never break the turn.
            }
          };

    return nativeModule.runTurnRust(
      params,
      makeCallbackHandler(llmChatCb),
      makeCallbackHandler(executeToolCb),
      eventHandler,
      // Tool-lifecycle channels: when all three are wired the engine reports
      // supports_tool_lifecycle and write-class tools run natively behind
      // the host approval gate; when absent they fall back to host execution.
      lifecycleCbs === undefined ? undefined : makeCallbackHandler(lifecycleCbs.prepareTool),
      lifecycleCbs === undefined ? undefined : makeCallbackHandler(lifecycleCbs.authorizeTool),
      lifecycleCbs === undefined ? undefined : makeCallbackHandler(lifecycleCbs.finalizeTool),
    );
  }
}

// ── Agent process manager (stdio JSON-RPC) ────────────────────────────────

class AgentProcess {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private ready = false;

  /** Callback for handling host/llm_chat requests from the Rust side. */
  private llmChatHandler: ((req: LlmChatRequest) => Promise<LlmChatResponse>) | null = null;

  /** Callback for handling host/execute_tool requests from the Rust side. */
  private toolExecuteHandler: ((req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) | null =
    null;

  /** Callback for handling host/prepare_tool_execution requests from the Rust side. */
  private prepareToolHandler:
    | ((req: PrepareToolRequest) => Promise<PrepareToolResponse | null>)
    | null = null;

  /** Callback for handling host/authorize_tool_execution requests from the Rust side. */
  private authorizeToolHandler:
    | ((req: AuthorizeToolRequest) => Promise<AuthorizeToolResponse | null>)
    | null = null;

  /** Callback for handling host/finalize_tool_result requests from the Rust side. */
  private finalizeToolHandler:
    | ((req: FinalizeToolRequest) => Promise<FinalizeToolResponse>)
    | null = null;

  /** Callback for fire-and-forget host/event notifications from Rust. */
  private eventHandler: ((event: EngineEvent) => void) | null = null;

  setLlmChatHandler(handler: (req: LlmChatRequest) => Promise<LlmChatResponse>) {
    this.llmChatHandler = handler;
  }

  setToolExecuteHandler(handler: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) {
    this.toolExecuteHandler = handler;
  }

  setPrepareToolHandler(handler: (req: PrepareToolRequest) => Promise<PrepareToolResponse | null>) {
    this.prepareToolHandler = handler;
  }

  setAuthorizeToolHandler(
    handler: (req: AuthorizeToolRequest) => Promise<AuthorizeToolResponse | null>,
  ) {
    this.authorizeToolHandler = handler;
  }

  setFinalizeToolHandler(handler: (req: FinalizeToolRequest) => Promise<FinalizeToolResponse>) {
    this.finalizeToolHandler = handler;
  }

  setEventHandler(handler: (event: EngineEvent) => void) {
    this.eventHandler = handler;
  }

  static findBinary(): string | null {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const arch = `${process.platform}-${process.arch}`;
    const devCandidates = [
      // Development: Rust build output. The Cargo workspace root (repo root)
      // is where builds land since the workspace-ification; the per-crate
      // target dir is the pre-workspace layout and may hold stale binaries.
      resolve(projectRoot, 'target/release/kimi-agent-cli' + ext),
      resolve(projectRoot, 'target/debug/kimi-agent-cli' + ext),
      resolve(projectRoot, 'packages/kimi-agent/target/release/kimi-agent-cli' + ext),
      resolve(projectRoot, 'packages/kimi-agent/target/debug/kimi-agent-cli' + ext),
    ];
    try {
      const fs = nodeRequire('node:fs') as typeof import('node:fs');
      // Pick the most recently built dev binary rather than the first hit:
      // with two possible target layouts, path order would silently prefer
      // a stale build over the one `cargo build` just produced.
      let newest: { path: string; mtimeMs: number } | null = null;
      for (const candidate of devCandidates) {
        try {
          const stat = fs.statSync(candidate);
          if (newest === null || stat.mtimeMs > newest.mtimeMs) {
            newest = { path: candidate, mtimeMs: stat.mtimeMs };
          }
        } catch {
          // missing candidate
        }
      }
      if (newest !== null) return newest.path;
      // Production: bundled alongside the SEA binary
      const bundled = resolve(projectRoot, 'dist-native', 'bin', arch, 'kimi-agent-cli' + ext);
      if (fs.existsSync(bundled)) return bundled;
    } catch {
      // ignore
    }
    return null;
  }

  start(): boolean {
    const binaryPath = AgentProcess.findBinary();
    if (!binaryPath) {
      console.warn('[kimi-agent] Binary not found, falling back to JS engine');
      return false;
    }

    try {
      this.process = spawn(binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.stdout!.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.process.stderr!.on('data', (data: Buffer) => {
        console.error(`[kimi-agent] ${data.toString().trim()}`);
      });

      this.process.on('exit', (code) => {
        console.warn(`[kimi-agent] Process exited with code ${code}`);
        this.process = null;
        for (const [id, { reject }] of this.pending) {
          reject(new Error(`Agent process exited with code ${code}`));
          this.pending.delete(id);
        }
      });

      this.ready = true;
      return true;
    } catch (error) {
      console.warn('[kimi-agent] Failed to start:', error);
      return false;
    }
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as RpcMessage;

        switch (classifyRpcMessage(msg)) {
          case 'request':
            this.handleHostRequest(msg).catch((error) => {
              console.error('[kimi-agent] Failed to handle host request:', error);
            });
            break;
          case 'response': {
            if (this.pending.has(msg.id as number)) {
              const pending = this.pending.get(msg.id as number)!;
              if (msg.error) {
                pending.reject(new Error(msg.error.message));
              } else {
                pending.resolve(msg.result);
              }
              this.pending.delete(msg.id as number);
            }
            break;
          }
          case 'ignore':
            // A method without an id is a notification — the engine's
            // fire-and-forget event channel arrives this way.
            if (msg.method === 'host/event' && this.eventHandler) {
              try {
                this.eventHandler(msg.params as EngineEvent);
              } catch {
                // Event handler failures must never break the RPC loop.
              }
            }
            break;
        }
      } catch {
        // ignore malformed JSON
      }
    }
  }

  private async handleHostRequest(msg: RpcMessage) {
    if (msg.method === 'host/llm_chat') {
      await this.handleHostLlmChat(msg);
    } else if (msg.method === 'host/execute_tool') {
      await this.handleHostExecuteTool(msg);
    } else if (msg.method === 'host/prepare_tool_execution') {
      await this.handleHostPrepareTool(msg);
    } else if (msg.method === 'host/authorize_tool_execution') {
      await this.handleHostAuthorizeTool(msg);
    } else if (msg.method === 'host/finalize_tool_result') {
      await this.handleHostFinalizeTool(msg);
    } else {
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown method: ${msg.method}` },
      });
      this.process!.stdin!.write(response + '\n');
    }
  }

  private async handleHostLlmChat(msg: RpcMessage) {
    if (!this.llmChatHandler) {
      this.writeHostError(msg.id, 'No LLM chat handler registered');
      return;
    }
    try {
      const result = await this.llmChatHandler(msg.params as LlmChatRequest);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleHostExecuteTool(msg: RpcMessage) {
    if (!this.toolExecuteHandler) {
      this.writeHostError(msg.id, 'No tool execute handler registered');
      return;
    }
    try {
      const result = await this.toolExecuteHandler(msg.params as ToolExecuteRequest);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleHostPrepareTool(msg: RpcMessage) {
    if (!this.prepareToolHandler) {
      // No handler registered — respond with null (allow unchanged).
      this.writeHostResult(msg.id, null);
      return;
    }
    try {
      const result = await this.prepareToolHandler(msg.params as PrepareToolRequest);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleHostAuthorizeTool(msg: RpcMessage) {
    if (!this.authorizeToolHandler) {
      // No handler registered — respond with null (allow unchanged).
      this.writeHostResult(msg.id, null);
      return;
    }
    try {
      const result = await this.authorizeToolHandler(msg.params as AuthorizeToolRequest);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleHostFinalizeTool(msg: RpcMessage) {
    if (!this.finalizeToolHandler) {
      // No handler registered — respond with null (use result as-is).
      this.writeHostResult(msg.id, null);
      return;
    }
    try {
      const result = await this.finalizeToolHandler(msg.params as FinalizeToolRequest);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private writeHostResult(id: unknown, result: unknown) {
    this.process!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private writeHostError(id: unknown, message: string) {
    this.process!.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }) + '\n',
    );
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.process || !this.ready) {
      throw new Error('Agent process is not running');
    }
    const id = this.nextId++;
    const request = { jsonrpc: '2.0' as const, id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.ready = false;
  }
}

// ── Engine selection ──────────────────────────────────────────────────────

/// Which transport is active for the current session.
type EngineMode = 'napi' | 'stdio' | 'js';

let engineMode: EngineMode = 'js';
let agentProcess: AgentProcess | null = null;
let napiEngine: NapiEngine | null = null;

/**
 * Initialize the Rust engine, preferring napi-rs over stdio JSON-RPC.
 * Returns the selected mode. Called once on first use; subsequent calls
 * return the same mode.
 */
function initEngine(): EngineMode {
  if (engineMode !== 'js') return engineMode;

  // 1) Try napi-rs first (in-process, no subprocess overhead)
  if (NapiEngine.isAvailable()) {
    const engine = new NapiEngine();
    if (engine.load()) {
      napiEngine = engine;
      engineMode = 'napi';
      return 'napi';
    }
  }

  // 2) Fall back to stdio JSON-RPC
  const process = new AgentProcess();
  if (process.start()) {
    agentProcess = process;
    engineMode = 'stdio';
    return 'stdio';
  }

  // 3) Both unavailable — fall back to JS
  engineMode = 'js';
  return 'js';
}

function getAgent(): AgentProcess | null {
  initEngine();
  return agentProcess;
}

function getNapiEngine(): NapiEngine | null {
  initEngine();
  return napiEngine;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function runTurnRust(
  params: RunTurnParams,
  handlers?: {
    llmChat?: (req: LlmChatRequest) => Promise<LlmChatResponse>;
    toolExecute?: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>;
    prepareTool?: (req: PrepareToolRequest) => Promise<PrepareToolResponse | null>;
    authorizeTool?: (req: AuthorizeToolRequest) => Promise<AuthorizeToolResponse | null>;
    finalizeTool?: (req: FinalizeToolRequest) => Promise<FinalizeToolResponse>;
  },
): Promise<RunTurnResult | null> {
  const agent = getAgent();
  if (!agent) return null;

  if (handlers?.llmChat) {
    agent.setLlmChatHandler(handlers.llmChat);
  }
  if (handlers?.toolExecute) {
    agent.setToolExecuteHandler(handlers.toolExecute);
  }
  if (handlers?.prepareTool) {
    agent.setPrepareToolHandler(handlers.prepareTool);
  }
  if (handlers?.authorizeTool) {
    agent.setAuthorizeToolHandler(handlers.authorizeTool);
  }
  if (handlers?.finalizeTool) {
    agent.setFinalizeToolHandler(handlers.finalizeTool);
  }

  try {
    const result = await agent.request('agent/run_turn', params);
    return result as RunTurnResult;
  } catch (error) {
    console.error('[kimi-agent] RPC call failed:', error);
    return null;
  }
}

/**
 * Create a `RunTurnOverride` function compatible with the agent-core turn loop.
 *
 * This adapter bridges the JS `RunTurnInput` (from agent-core) and the Rust
 * kimi-agent binary. The host stays authoritative: Rust drives control flow
 * and calls back per step/tool, while the host owns the message history and
 * transcript. It:
 * 1. Sends `agent/run_turn` to the Rust binary (no message content — see below)
 * 2. Handles `host/llm_chat` by rebuilding messages from `context` and calling
 *    `input.llm.chat()`, dispatching step/content events as it goes
 * 3. Handles `host/execute_tool` by running the full tool lifecycle
 *    (prepare -> resolve -> authorize permission gate -> execute -> finalize)
 *    and dispatching tool.call / tool.result
 * 4. Maps the Rust response back to the JS `TurnResult` type
 *
 * Turn-lifecycle parity with the JS loop:
 * - Host-proxy mode: `hooks.beforeStep` (compaction, steer-buffer flush,
 *   context injection) runs before every model step and a blocking result
 *   fails the step; `recordStepUsage` / `hooks.afterStep` run after every
 *   step (goal token accounting), and a reported hard stop ends the turn at
 *   the next callback.
 * - Native-LLM mode: Rust owns the in-turn history, so `beforeStep` does NOT
 *   run mid-turn — steered messages land at continuation boundaries instead.
 *   Per-step accounting still runs, hooked into the `llm.step.end` event.
 * - `hooks.shouldContinueAfterStop` runs when the Rust drive stops; a granted
 *   continuation re-drives the engine with the remaining step budget (and,
 *   in native-LLM mode, re-serializes the history so flushed steers are seen).
 * - Abort: both transports set the engine's per-turn cancellation flag
 *   (stdio: `agent/cancel_turn`; napi: `cancelTurnRust`), checked before
 *   every Rust step — native-LLM turns included; host callbacks
 *   short-circuit on both transports; the result maps to stopReason
 *   'aborted' (never a failure). An in-flight provider request still
 *   finishes its current step before the flag takes effect.
 *
 * Returns `undefined` when the Rust binary is not available (falls back to JS).
 */
export function createRunTurnOverride(
  providers?: LlmProviderDef[],
  workspaceRoot?: string,
  options?: RustEngineOptions,
): import('@moonshot-ai/agent-core').RunTurnOverride | undefined {
  const mode = initEngine();
  if (mode === 'js') return undefined;

  const nativeLlm = options?.nativeLlm;
  const nativeTools = options?.nativeTools === true;

  // Build a lightweight workspace predictor for the Read prediction fast-path.
  // When the Rust engine calls host/execute_tool with force_precise=false for
  // a Read call, we return a prediction (first few lines + metadata) so the
  // LLM can continue immediately. The Rust engine then spawns a background
  // force_precise=true call, which executes the full read and replaces the
  // prediction in the transcript via input.replaceToolResult.
  const predictor = workspaceRoot ? new WorkspacePredictor(workspaceRoot) : undefined;

  return async (input) => {
    // The prediction fast-path requires transcript replacement. If the host
    // doesn't provide replaceToolResult, predictions are disabled and all
    // reads execute precisely on the first call.
    const predictionEnabled = predictor !== undefined && input.replaceToolResult !== undefined;

    // Step lifecycle. The host owns the transcript AND the message history:
    // Rust drives control flow and calls back per LLM step and per tool. We
    // open an assistant "step" on host/llm_chat and keep it open — recording
    // tool.call / tool.result against it — until the next llm_chat (or turn
    // end) closes it with step.end. buildMessages() re-reads `context` each
    // step, so these recorded events are exactly what thread history forward.
    let currentStep = 0;
    let openStep: { uuid: string; step: number; usage: HostTokenUsage } | undefined;
    const closeOpenStep = async (): Promise<void> => {
      if (openStep === undefined) return;
      const { uuid, step, usage } = openStep;
      openStep = undefined;
      await input.dispatchEvent({ type: 'step.end', uuid, turnId: input.turnId, step, usage });
    };
    const outputToContent = (output: unknown): string =>
      typeof output === 'string' ? output : JSON.stringify(output);

    // Ask the engine to stop this turn at its next step boundary. Both
    // transports expose a per-turn cancellation flag (stdio: the
    // `agent/cancel_turn` RPC; napi: the `cancelTurnRust` export) — this
    // stops native-LLM turns too, where the host llm callback never runs.
    const requestEngineCancel = (turnId: string): void => {
      if (mode === 'stdio') {
        void getAgent()
          ?.request('agent/cancel_turn', { turn_id: turnId })
          .catch(() => {});
      } else {
        getNapiEngine()?.cancelTurn(turnId);
      }
    };

    // ── Engine event handler (native LLM / native tool paths) ────────
    // Rust reports step boundaries, streaming deltas, and natively-executed
    // tool results over the fire-and-forget event channel. Events arrive
    // synchronously but dispatching is async, so they are serialized
    // through a promise chain to preserve transcript ordering.
    let eventChain: Promise<void> = Promise.resolve();
    const processEngineEvent = async (event: EngineEvent): Promise<void> => {
      switch (event.type) {
        case 'llm.step.begin': {
          await closeOpenStep();
          currentStep += 1;
          const stepUuid = randomUUID();
          await input.dispatchEvent({
            type: 'step.begin',
            uuid: stepUuid,
            turnId: input.turnId,
            step: currentStep,
          });
          openStep = { uuid: stepUuid, step: currentStep, usage: { ...ZERO_USAGE } };
          break;
        }
        case 'llm.delta': {
          if (openStep === undefined) break;
          const part = event['part'] as { type?: string; text?: string; think?: string };
          await input.dispatchEvent({
            type: 'content.part',
            uuid: randomUUID(),
            turnId: input.turnId,
            step: openStep.step,
            stepUuid: openStep.uuid,
            part: part as never,
          });
          // `content.part` only records into the context; the UI stream is the
          // separate `text.delta`/`thinking.delta` channel (mapped to
          // `assistant.delta` by the session-event projector). Without this,
          // print mode and the TUI render nothing for Rust-driven turns.
          if (part.type === 'text' && part.text !== undefined && part.text.length > 0) {
            input.dispatchEvent({ type: 'text.delta', delta: part.text });
          } else if (part.type === 'think' && part.think !== undefined && part.think.length > 0) {
            input.dispatchEvent({ type: 'thinking.delta', delta: part.think });
          }
          break;
        }
        case 'llm.step.end': {
          if (openStep === undefined) break;
          const usage = event['usage'] as
            | { input_tokens?: number; output_tokens?: number }
            | undefined;
          openStep.usage = {
            inputOther: usage?.input_tokens ?? 0,
            output: usage?.output_tokens ?? 0,
            inputCacheRead: 0,
            inputCacheCreation: 0,
          };
          // Native-LLM parity: this event only fires when Rust calls the
          // provider itself (llm/http.rs), where the host llm callback — and
          // with it the per-step accounting in `llmChatHandler` — never runs.
          // Goal token accounting (recordStepUsage + afterStep) hooks in here
          // instead. A reported hard stop asks the engine to abort at its
          // next step boundary (cancel_turn RPC on stdio, cancelTurnRust on
          // napi).
          const stepUsage = openStep.usage;
          lastStepUsage = stepUsage;
          const stepToolCalls = event['tool_calls'] as unknown[] | undefined;
          const recorded = await input.recordStepUsage?.(stepUsage);
          let stopAfterStep = recorded?.stopTurn === true;
          try {
            const after = await input.hooks?.afterStep?.({
              turnId: input.turnId,
              stepNumber: openStep.step,
              signal: input.signal,
              llm: input.llm,
              usage: stepUsage,
              stopReason: ((stepToolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn') as never,
            });
            stopAfterStep = stopAfterStep || after?.stopTurn === true;
          } catch {
            // Sealed step — observer hooks cannot change the result.
          }
          if (stopAfterStep) {
            stopTurnRequested = true;
            requestEngineCancel(input.turnId);
          }
          break;
        }
        case 'tool.native': {
          // A tool that executed inside the Rust process — mirror the
          // call/result pair into the transcript.
          if (openStep === undefined) break;
          const rawCallId = event['tool_call_id'];
          const toolCallId = typeof rawCallId === 'string' ? rawCallId : randomUUID();
          const toolName = typeof event['tool_name'] === 'string' ? event['tool_name'] : '';
          await input.dispatchEvent({
            type: 'tool.call',
            uuid: toolCallId,
            turnId: input.turnId,
            step: openStep.step,
            stepUuid: openStep.uuid,
            toolCallId,
            name: toolName,
            args: event['arguments'],
          });
          await input.dispatchEvent({
            type: 'tool.result',
            parentUuid: toolCallId,
            toolCallId,
            result: { output: event['content'], isError: event['is_error'] === true } as never,
          });
          break;
        }
        default:
          break;
      }
    };
    const handleEngineEvent = (event: EngineEvent): void => {
      eventChain = eventChain.then(() => processEngineEvent(event)).catch(() => {});
    };

    // ── Native LLM initial messages ───────────────────────────────
    // When Rust calls the provider directly it owns the in-turn message
    // history, so the host serializes the current history (text, images,
    // and tool-call structure) once at turn start.
    interface HostContentPart {
      type: string;
      text?: string;
      imageUrl?: { url: string };
    }
    interface HostMessage {
      role: string;
      content: HostContentPart[];
      toolCalls?: { id: string; name: string; arguments: string | null }[];
      toolCallId?: string;
    }
    const toWireMessage = (m: HostMessage): WireMessage => {
      let text = '';
      let hasMedia = false;
      const blocks: WireContentBlock[] = [];
      for (const part of m.content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          text += part.text;
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url' && part.imageUrl?.url !== undefined) {
          hasMedia = true;
          blocks.push({ type: 'image_url', url: part.imageUrl.url });
        }
        // think/audio/video parts are not projected to the native wire.
      }
      const toolCalls = (m.toolCalls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments === null ? {} : tryParseJson(tc.arguments),
      }));
      return {
        role: m.role,
        content: text,
        blocks: hasMedia ? blocks : undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        tool_call_id: m.toolCallId,
      };
    };
    const buildWireMessages = async (): Promise<WireMessage[]> => {
      const messages = (await input.buildMessages()) as unknown as HostMessage[];
      return messages.map(toWireMessage);
    };
    const buildWireTools = (): { name: string; description: string; parameters: unknown }[] => {
      const stepTools = input.buildTools?.() ?? input.tools ?? [];
      return stepTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: (t as { parameters?: unknown }).parameters ?? {},
      }));
    };

    // ── LLM chat handler ──────────────────────────────────────────────
    // Set when a completed step reports a reached hard limit (goal token
    // budget via recordStepUsage / afterStep). The next model-step callback
    // then ends the turn with a synthetic stop instead of running another
    // step — mirroring the JS loop, which stops after the step that hit the
    // limit. Reset at continuation boundaries so a granted extra step runs.
    let stopTurnRequested = false;
    let lastStepUsage: HostTokenUsage = { ...ZERO_USAGE };
    // Media projection state, turn-scoped as in the JS loop: once a step only
    // succeeded via the media-degraded / media-stripped resend, later steps
    // build from that projection directly — the full-media history is
    // deterministically over the provider's limit, so rebuilding it would pay
    // a fresh rejection on every step (see turn-step.ts).
    let mediaProjection: 'normal' | 'degraded' | 'stripped' = 'normal';
    const syntheticStop = (): LlmChatResponse => ({
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
    const llmChatHandler = async (): Promise<LlmChatResponse> => {
      // An aborted turn must not run another model step. A clean synthetic
      // stop lets the Rust loop terminate; the final result maps to 'aborted'
      // (signal.aborted is re-checked there), so a cancel is never misread
      // as a turn failure. Same short-circuit for a host-requested stop.
      if (input.signal.aborted || stopTurnRequested) return syntheticStop();
      await closeOpenStep();
      currentStep += 1;
      const stepUuid = randomUUID();
      const stepNum = currentStep;
      // Pre-step lifecycle, as the JS loop runs it before each step
      // (turn-step.ts): compaction, steer-buffer flush, and context injection
      // all live in this hook, and a blocking result fails the step. Without
      // it, mid-turn steered messages (user interrupts, background-task
      // notifications) never reach the context, because `flushSteerBuffer`
      // is only ever called from these hooks. Host-proxy mode only: in
      // native-LLM mode this callback never runs (see the doc comment).
      const beforeStep = await input.hooks?.beforeStep?.({
        turnId: input.turnId,
        stepNumber: stepNum,
        signal: input.signal,
        llm: input.llm,
      });
      if (beforeStep?.block === true) {
        throw new Error(beforeStep.reason ?? `Step ${String(stepNum)} was blocked`);
      }
      await input.dispatchEvent({
        type: 'step.begin',
        uuid: stepUuid,
        turnId: input.turnId,
        step: stepNum,
      });
      openStep = { uuid: stepUuid, step: stepNum, usage: { ...ZERO_USAGE } };

      const stepTools = input.buildTools?.() ?? input.tools ?? [];
      const buildProjectedMessages = async () => {
        if (mediaProjection === 'stripped' && input.buildMessagesMediaStripped !== undefined) {
          return input.buildMessagesMediaStripped();
        }
        if (mediaProjection === 'degraded' && input.buildMessagesMediaDegraded !== undefined) {
          return input.buildMessagesMediaDegraded();
        }
        return input.buildMessages();
      };
      const chatOnce = async (messages: Awaited<ReturnType<typeof input.buildMessages>>) =>
        input.llm.chat({
          messages,
          tools: stepTools,
          signal: input.signal,
          onTextPart: async (part) => {
            await input.dispatchEvent({
              type: 'content.part',
              uuid: randomUUID(),
              turnId: input.turnId,
              step: stepNum,
              stepUuid,
              part,
            });
            // Mirror to the UI stream — see the llm.delta handler.
            if (part.type === 'text' && part.text.length > 0) {
              input.dispatchEvent({ type: 'text.delta', delta: part.text });
            }
          },
          onThinkPart: async (part) => {
            await input.dispatchEvent({
              type: 'content.part',
              uuid: randomUUID(),
              turnId: input.turnId,
              step: stepNum,
              stepUuid,
              part,
            });
            if (part.type === 'think' && part.think.length > 0) {
              input.dispatchEvent({ type: 'thinking.delta', delta: part.think });
            }
          },
        });
      // The recovery ladder from the JS loop's `executeLoopStep`, host-proxy
      // edition. Without it a Rust-driven session stays stuck on request
      // rejections the JS loop recovers from:
      //   413 body-too-large → media-degraded resend → media-stripped resend
      //   image-format rejection → media-stripped resend
      //   structural 400 → one-shot strict wire-compliant rebuild
      // Successful media resends latch `mediaProjection` for later steps.
      // (Native-LLM mode never reaches this handler; the ladder is
      // host-proxy only.)
      const resendWithRecovery = async (
        error: unknown,
      ): Promise<Awaited<ReturnType<typeof chatOnce>>> => {
        if (error instanceof APIRequestTooLargeError) {
          if (mediaProjection === 'normal' && input.buildMessagesMediaDegraded !== undefined) {
            input.log?.warn('request body too large; resending with media degraded', {
              turnStep: `${input.turnId}.${String(stepNum)}`,
            });
            try {
              const recovered = await chatOnce(await input.buildMessagesMediaDegraded());
              mediaProjection = 'degraded';
              return recovered;
            } catch (secondError) {
              if (
                !(secondError instanceof APIRequestTooLargeError) ||
                input.buildMessagesMediaStripped === undefined
              ) {
                throw secondError;
              }
              const recovered = await chatOnce(await input.buildMessagesMediaStripped());
              mediaProjection = 'stripped';
              return recovered;
            }
          }
          if (mediaProjection !== 'stripped' && input.buildMessagesMediaStripped !== undefined) {
            const recovered = await chatOnce(await input.buildMessagesMediaStripped());
            mediaProjection = 'stripped';
            return recovered;
          }
          throw error;
        }
        if (
          isImageFormatError(error) &&
          mediaProjection !== 'stripped' &&
          input.buildMessagesMediaStripped !== undefined
        ) {
          input.log?.warn('provider rejected an image; resending with media stripped', {
            turnStep: `${input.turnId}.${String(stepNum)}`,
          });
          const recovered = await chatOnce(await input.buildMessagesMediaStripped());
          mediaProjection = 'stripped';
          return recovered;
        }
        if (isRecoverableRequestStructureError(error) && input.buildMessagesStrict !== undefined) {
          input.log?.warn('provider rejected request structure; resending with strict projection', {
            turnStep: `${input.turnId}.${String(stepNum)}`,
          });
          return chatOnce(await input.buildMessagesStrict());
        }
        throw error;
      };

      let response;
      try {
        response = await chatOnce(await buildProjectedMessages());
      } catch (error) {
        // A cancel usually surfaces as the in-flight chat rejecting on the
        // abort signal. Convert it into a synthetic stop so the Rust loop
        // terminates cleanly instead of retrying a "failed" step; the final
        // result still maps to 'aborted'.
        if (input.signal.aborted) return syntheticStop();
        try {
          response = await resendWithRecovery(error);
        } catch (finalError) {
          if (input.signal.aborted) return syntheticStop();
          throw finalError;
        }
      }
      if (openStep !== undefined) openStep.usage = response.usage;

      // Post-step lifecycle, as in the JS loop: goal token accounting first
      // (recordStepUsage), then afterStep (usage recording + compaction +
      // dedupe bookkeeping). Either may request a hard stop after this step.
      // afterStep failures are swallowed, matching turn-step.ts: the step is
      // already sealed, observer hooks cannot change the result.
      const stepUsage = response.usage ?? { ...ZERO_USAGE };
      lastStepUsage = stepUsage;
      const recorded = await input.recordStepUsage?.(stepUsage);
      if (recorded?.stopTurn === true) stopTurnRequested = true;
      try {
        const after = await input.hooks?.afterStep?.({
          turnId: input.turnId,
          stepNumber: stepNum,
          signal: input.signal,
          llm: input.llm,
          usage: stepUsage,
          stopReason: ((response.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn') as never,
        });
        if (after?.stopTurn === true) stopTurnRequested = true;
      } catch {
        // Sealed step — see above.
      }

      return {
        tool_calls:
          response.toolCalls?.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments ? tryParseJson(tc.arguments) : null,
          })) ?? [],
        finish_reason: response.providerFinishReason ?? 'stop',
        usage: {
          input_tokens: response.usage?.inputOther ?? 0,
          output_tokens: response.usage?.output ?? 0,
          total_tokens: (response.usage?.inputOther ?? 0) + (response.usage?.output ?? 0),
        },
      };
    };

    // ── Tool execution handler ────────────────────────────────────────
    const toolExecuteHandler = async (req: ToolExecuteRequest): Promise<ToolExecuteResponse> => {
      // A cancelled turn stops executing tools immediately — the JS loop
      // settles every remaining call as aborted the same way.
      if (input.signal.aborted) {
        return { content: `Tool "${req.tool_name}" was aborted`, is_error: true };
      }
      const stepTools = input.buildTools?.() ?? input.tools ?? [];
      const tool = stepTools.find((t) => t.name === req.tool_name);
      const toolCallId = req.tool_call_id;
      const stepUuid = openStep?.uuid;
      const stepNum = openStep?.step ?? currentStep;
      const toolCall = {
        type: 'function' as const,
        id: toolCallId,
        name: req.tool_name,
        arguments: req.arguments === undefined ? null : JSON.stringify(req.arguments),
      };

      const isPreciseReplacement = req.force_precise && predictionEnabled;

      let callDispatched = false;
      const emitCall = async (callArgs: unknown): Promise<void> => {
        if (callDispatched || stepUuid === undefined || isPreciseReplacement) return;
        callDispatched = true;
        await input.dispatchEvent({
          type: 'tool.call',
          uuid: toolCallId,
          turnId: input.turnId,
          step: stepNum,
          stepUuid,
          toolCallId,
          name: req.tool_name,
          args: callArgs,
        });
      };
      const settle = async (
        toolResult: { output: unknown; isError?: boolean | undefined; note?: string | undefined },
        callArgs: unknown,
      ): Promise<ToolExecuteResponse> => {
        if (isPreciseReplacement) {
          input.replaceToolResult(toolCallId, toolResult);
          return {
            content: outputToContent(toolResult.output),
            is_error: toolResult.isError === true,
          };
        }
        await emitCall(callArgs);
        if (stepUuid !== undefined) {
          await input.dispatchEvent({
            type: 'tool.result',
            parentUuid: toolCallId,
            toolCallId,
            result: toolResult as never,
          });
        }
        return {
          content: outputToContent(toolResult.output),
          is_error: toolResult.isError === true,
        };
      };

      // ── Prediction fast-path ────────────────────────────────────────
      if (!req.force_precise && predictionEnabled && req.tool_name === 'read') {
        const args = req.arguments as { path?: string } | null;
        const filePath = args?.path;
        if (filePath) {
          const prediction = predictor.predictRead(filePath);
          if (prediction !== null) {
            await emitCall(req.arguments);
            if (stepUuid !== undefined) {
              await input.dispatchEvent({
                type: 'tool.result',
                parentUuid: toolCallId,
                toolCallId,
                result: { output: prediction } as never,
              });
            }
            return { content: prediction, is_error: false, is_prediction: true };
          }
        }
      }

      if (!tool) {
        const missing =
          input.describeMissingTool?.(req.tool_name) ?? `Tool "${req.tool_name}" not found`;
        return settle({ output: missing, isError: true }, req.arguments);
      }

      const hookCtxBase = {
        toolCall,
        toolCalls: [toolCall],
        tool,
        turnId: input.turnId,
        stepNumber: stepNum,
        signal: input.signal,
        llm: input.llm,
      };

      let effectiveArgs: unknown = req.arguments;
      const prep = await input.hooks?.prepareToolExecution?.({
        ...hookCtxBase,
        args: effectiveArgs,
      });
      if (prep?.updatedArgs !== undefined) effectiveArgs = prep.updatedArgs;
      if (prep?.block === true) {
        return settle(
          { output: prep.reason ?? `Tool call "${req.tool_name}" was blocked`, isError: true },
          effectiveArgs,
        );
      }
      if (prep?.syntheticResult !== undefined) {
        return settle(prep.syntheticResult, effectiveArgs);
      }
      let executionMetadata = prep?.executionMetadata;

      let execution;
      try {
        execution = await tool.resolveExecution(effectiveArgs);
      } catch (error) {
        return settle(
          { output: error instanceof Error ? error.message : String(error), isError: true },
          effectiveArgs,
        );
      }

      if ('isError' in execution && execution.isError === true) {
        return settle(execution, effectiveArgs);
      }
      if (!('execute' in execution)) {
        return settle(
          { output: 'Tool execution resolved without executable', isError: true },
          effectiveArgs,
        );
      }

      const auth = await input.hooks?.authorizeToolExecution?.({
        ...hookCtxBase,
        args: effectiveArgs,
        execution,
      });
      if (auth?.block === true) {
        return settle(
          { output: auth.reason ?? `Tool call "${req.tool_name}" was blocked`, isError: true },
          effectiveArgs,
        );
      }
      if (auth?.syntheticResult !== undefined) {
        return settle(auth.syntheticResult, effectiveArgs);
      }
      executionMetadata = auth?.executionMetadata ?? executionMetadata;

      await emitCall(effectiveArgs);

      let rawResult: { output: unknown; isError?: boolean | undefined; note?: string | undefined };
      try {
        rawResult = await execution.execute({
          turnId: req.turn_id,
          toolCallId,
          metadata: executionMetadata,
          signal: input.signal,
        });
      } catch (error) {
        rawResult = {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }

      const finalized =
        (await input.hooks?.finalizeToolResult?.({
          ...hookCtxBase,
          args: effectiveArgs,
          result: rawResult as never,
        })) ?? rawResult;

      return settle(finalized, effectiveArgs);
    };

    // ── Tool lifecycle hooks (new: Rust tool_call.rs -> JS) ──────────────
    const prepareToolHandler = async (
      req: PrepareToolRequest,
    ): Promise<PrepareToolResponse | null> => {
      if (!input.hooks?.prepareToolExecution) return null;
      const stepTools = input.buildTools?.() ?? input.tools ?? [];
      const tool = stepTools.find((t) => t.name === req.tool_name);
      const toolCall: { id: string; name: string; arguments: string; type: 'function' } = {
        id: req.tool_call_id,
        name: req.tool_name,
        arguments:
          typeof req.arguments === 'string' ? req.arguments : JSON.stringify(req.arguments ?? {}),
        type: 'function',
      };
      try {
        const result = await input.hooks.prepareToolExecution({
          toolCall,
          toolCalls: [toolCall],
          tool,
          args: req.arguments,
          turnId: input.turnId,
          stepNumber: req.step_number,
          traceId: req.trace_id,
          signal: input.signal,
          llm: input.llm,
        });
        if (!result) return null;
        if (result.block) {
          return { block: true, reason: result.reason, resolved: true };
        }
        if (result.syntheticResult) {
          return {
            block: false,
            synthetic_result: {
              content: outputToContent(result.syntheticResult.output),
              is_error: result.syntheticResult.isError === true,
              stop_turn: result.syntheticResult.stopTurn === true,
              is_prediction: false,
            },
            updated_args: result.updatedArgs,
            execution_metadata: result.executionMetadata,
            resolved: true,
          };
        }
        return {
          block: false,
          updated_args: result.updatedArgs,
          execution_metadata: result.executionMetadata,
          resolved: true,
        };
      } catch {
        return null;
      }
    };

    const authorizeToolHandler = async (
      req: AuthorizeToolRequest,
    ): Promise<AuthorizeToolResponse | null> => {
      if (!input.hooks?.authorizeToolExecution) return null;
      const stepTools = input.buildTools?.() ?? input.tools ?? [];
      const tool = stepTools.find((t) => t.name === req.tool_name);
      const toolCall: { id: string; name: string; arguments: string; type: 'function' } = {
        id: req.tool_call_id,
        name: req.tool_name,
        arguments:
          typeof req.arguments === 'string' ? req.arguments : JSON.stringify(req.arguments ?? {}),
        type: 'function',
      };
      try {
        const result = await input.hooks.authorizeToolExecution({
          toolCall,
          toolCalls: [toolCall],
          tool,
          args: req.arguments,
          turnId: input.turnId,
          stepNumber: req.step_number,
          traceId: req.trace_id,
          signal: input.signal,
          llm: input.llm,
          execution: {
            approvalRule: req.approval_rule,
            execute: async () => ({ output: '', isError: false }),
            accesses: undefined as never,
          },
        });
        if (!result) return null;
        if (result.block) {
          return { block: true, reason: result.reason, resolved: true };
        }
        if (result.syntheticResult) {
          return {
            block: false,
            synthetic_result: {
              content: outputToContent(result.syntheticResult.output),
              is_error: result.syntheticResult.isError === true,
              stop_turn: result.syntheticResult.stopTurn === true,
              is_prediction: false,
            },
            execution_metadata: result.executionMetadata,
            resolved: true,
          };
        }
        return { block: false, execution_metadata: result.executionMetadata, resolved: true };
      } catch {
        return null;
      }
    };

    const finalizeToolHandler = async (req: FinalizeToolRequest): Promise<FinalizeToolResponse> => {
      if (!input.hooks?.finalizeToolResult) return null;
      const toolCall: { id: string; name: string; arguments: string; type: 'function' } = {
        id: req.tool_call_id,
        name: req.tool_name,
        arguments:
          typeof req.arguments === 'string' ? req.arguments : JSON.stringify(req.arguments ?? {}),
        type: 'function',
      };
      try {
        const result = await input.hooks.finalizeToolResult({
          toolCall,
          toolCalls: [toolCall],
          args: req.arguments,
          result: req.result as never,
          turnId: input.turnId,
          stepNumber: req.step_number,
          traceId: req.trace_id,
          signal: input.signal,
          llm: input.llm,
        });
        if (!result) return null;
        return {
          content: outputToContent(result.output),
          is_error: result.isError === true,
          note: result.note,
          is_prediction: false,
          stop_turn: result.stopTurn === true,
        };
      } catch {
        return null;
      }
    };

    // ── Drive the turn ────────────────────────────────────────────────
    // In host-proxy mode, message content and the tool table are NOT sent:
    // the host rebuilds both from `context` on every host/llm_chat callback
    // (the source of truth), so Rust only needs metadata to drive control
    // flow. In native LLM mode, Rust calls the provider itself, so the
    // history and tool schemas are serialized at the start of every drive
    // (re-serialized on each continuation so flushed steer messages are
    // included) and progress flows back over the event channel.
    const runRustOnce = async (maxSteps: number): Promise<RunTurnResult> => {
      const wireMessages = nativeLlm === undefined ? [] : await buildWireMessages();
      const wireTools = nativeLlm === undefined ? [] : buildWireTools();
      if (mode === 'napi') {
        const engine = getNapiEngine()!;
        // Napi callbacks use JSON-serialized payloads (string → string)
        const napiResult = await engine.runTurn(
          {
            turnId: input.turnId,
            systemPrompt: input.llm.systemPrompt,
            modelName: input.llm.modelName,
            messages: wireMessages.map((m) => ({
              role: m.role,
              content: m.content,
              blocksJson: m.blocks === undefined ? undefined : JSON.stringify(m.blocks),
              toolCallsJson: m.tool_calls === undefined ? undefined : JSON.stringify(m.tool_calls),
              toolCallId: m.tool_call_id,
            })),
            tools: wireTools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: JSON.stringify(t.parameters ?? {}),
            })),
            maxSteps,
            nativeLlm:
              nativeLlm === undefined
                ? undefined
                : {
                    protocol: nativeLlm.protocol,
                    apiKey: nativeLlm.api_key,
                    baseUrl: nativeLlm.base_url,
                    model: nativeLlm.model,
                    maxTokens: nativeLlm.max_tokens,
                  },
            workspaceRoot,
            nativeTools,
          },
          // Wrap structured handler with JSON serialization for napi
          async (_requestJson: string) => {
            const response = await llmChatHandler();
            return JSON.stringify(response);
          },
          async (requestJson: string) => {
            const req = JSON.parse(requestJson) as ToolExecuteRequest;
            const response = await toolExecuteHandler(req);
            return JSON.stringify(response);
          },
          handleEngineEvent,
          {
            // Tool-lifecycle channels (JSON ↔ JSON): reuse the same typed
            // handlers as the stdio transport, so napi write-class tools run
            // behind the identical prepare/authorize/finalize gate.
            prepareTool: async (requestJson: string) =>
              JSON.stringify(
                await prepareToolHandler(JSON.parse(requestJson) as PrepareToolRequest),
              ),
            authorizeTool: async (requestJson: string) =>
              JSON.stringify(
                await authorizeToolHandler(JSON.parse(requestJson) as AuthorizeToolRequest),
              ),
            finalizeTool: async (requestJson: string) =>
              JSON.stringify(
                await finalizeToolHandler(JSON.parse(requestJson) as FinalizeToolRequest),
              ),
          },
        );
        return {
          stop_reason: napiResult.stopReason,
          steps: napiResult.steps,
          usage: {
            input_tokens: napiResult.inputTokens,
            output_tokens: napiResult.outputTokens,
            total_tokens: napiResult.totalTokens,
          },
        };
      }
      // stdio JSON-RPC path
      const agent = getAgent()!;
      agent.setLlmChatHandler(llmChatHandler);
      agent.setToolExecuteHandler(toolExecuteHandler);
      agent.setPrepareToolHandler(prepareToolHandler);
      agent.setAuthorizeToolHandler(authorizeToolHandler);
      agent.setFinalizeToolHandler(finalizeToolHandler);
      agent.setEventHandler(handleEngineEvent);

      const result = await agent.request('agent/run_turn', {
        turn_id: input.turnId,
        system_prompt: input.llm.systemPrompt,
        model_name: input.llm.modelName,
        messages: wireMessages,
        tools: wireTools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters ?? {},
        })),
        max_steps: maxSteps,
        providers: providers ?? [],
        native_llm: nativeLlm,
        workspace_root: workspaceRoot,
        native_tools: nativeTools,
      });
      if (!result) {
        throw new Error('Rust engine returned null result');
      }
      return result as RunTurnResult;
    };

    // ── Abort propagation ───────────────────────────────────────
    // `requestEngineCancel` (above) sets the engine's per-turn cancellation
    // flag, checked before every Rust step. The synthetic-stop
    // short-circuits in the llm/tool handlers additionally end host-proxy
    // turns at the very next callback. An in-flight provider request still
    // finishes its step; the flag takes effect at the following boundary.
    const onAbort = (): void => {
      requestEngineCancel(input.turnId);
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    // ── Continuation loop ───────────────────────────────────────
    // Mirrors the JS loop's `shouldContinueAfterStop`: after the Rust drive
    // stops, the host hook flushes buffered steer messages and decides
    // whether the model gets another step to react (steer follow-up, goal
    // outcome message, Stop-hook continuation). Each granted continuation
    // re-drives the Rust engine with the remaining step budget.
    const maxStepsBudget = input.maxSteps ?? 10;
    let totalSteps = 0;
    const usageTotal = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let stopReason = mapStopReason('EndTurn');
    try {
      while (!input.signal.aborted) {
        const remaining = maxStepsBudget - totalSteps;
        if (remaining <= 0) break;
        const rustResult = await runRustOnce(remaining);
        totalSteps += rustResult.steps;
        usageTotal.input_tokens += rustResult.usage.input_tokens;
        usageTotal.output_tokens += rustResult.usage.output_tokens;
        usageTotal.total_tokens += rustResult.usage.total_tokens;
        stopReason = mapStopReason(rustResult.stop_reason);
        if (stopReason === 'aborted' && !input.signal.aborted && stopTurnRequested) {
          // The engine aborted because the host asked it to stop after a
          // hard per-step limit (goal budget → cancel_turn on the stdio
          // native-LLM path), not because the user cancelled. Report the
          // natural end so the caller applies budget semantics — mapping
          // this to 'aborted' would pause the goal as user-interrupted.
          stopReason = mapStopReason('EndTurn');
        }
        if (input.signal.aborted || stopReason === 'aborted') break;
        const continuation = await input.hooks?.shouldContinueAfterStop?.({
          turnId: input.turnId,
          stepNumber: currentStep,
          usage: lastStepUsage,
          stopReason: stopReason as never,
          signal: input.signal,
          llm: input.llm,
        });
        if (continuation?.continue !== true) break;
        // A granted continuation explicitly allows further steps (the hook
        // itself refuses while an active goal is over budget), so clear the
        // per-step hard-stop latch before re-driving.
        stopTurnRequested = false;
      }
    } catch (error) {
      // A cancel can surface as an error from the transport (rejected
      // callback, RPC failure after cancel_turn). Report it as an aborted
      // turn — not a failed one — so the caller maps it to 'cancelled' and a
      // running goal pauses as interrupted instead of errored.
      if (!input.signal.aborted) {
        // Loop-parity diagnostics: the JS loop reports abnormal endings via
        // `turn.interrupted` with step detail (run-turn.ts). Aborts are
        // deliberately NOT reported here — the host synthesizes the
        // interrupt with the correct user_cancelled attribution when no
        // loop event arrived (turn/index.ts fallback).
        void input.dispatchEvent({
          type: 'turn.interrupted',
          reason: 'error',
          attemptedSteps: currentStep,
          activeStep: currentStep,
          message: error instanceof Error ? error.message : String(error),
          interruptReason: 'error',
        } as never);
        throw error;
      }
    } finally {
      input.signal.removeEventListener('abort', onAbort);
      // Flush queued engine events before closing the last step so the
      // transcript records deltas/tool results in order.
      await eventChain.catch(() => {});
      await closeOpenStep();
    }
    if (input.signal.aborted) {
      stopReason = mapStopReason('Aborted');
    }

    return {
      stopReason,
      steps: totalSteps,
      usage: {
        inputOther: usageTotal.input_tokens,
        output: usageTotal.output_tokens,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    };
  };
}

/**
 * Map Rust-style stop reason to JS LoopTurnStopReason.
 */
export function mapStopReason(
  reason: string,
): Awaited<ReturnType<import('@moonshot-ai/agent-core').RunTurnOverride>>['stopReason'] {
  switch (reason) {
    case 'EndTurn':
      return 'end_turn' as never;
    case 'MaxTokens':
      return 'max_tokens' as never;
    case 'Filtered':
      return 'filtered' as never;
    case 'Paused':
      return 'paused' as never;
    case 'Aborted':
      return 'aborted' as never;
    case 'BudgetLimited':
      return 'budget_limited' as never;
    default:
      return 'unknown' as never;
  }
}

/**
 * Try to parse a JSON string into a value. Returns the original string if parsing fails.
 */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function isRustEngineAvailable(): boolean {
  return NapiEngine.isAvailable() || AgentProcess.findBinary() !== null;
}

/**
 * Which transport the Rust engine selected. Reports `'js'` until the first
 * `createRunTurnOverride`/`runTurnRust` call initializes the engine — it
 * never triggers initialization itself, so it is safe to call for logging.
 */
export function getRustEngineMode(): 'napi' | 'stdio' | 'js' {
  return engineMode;
}

export function shutdownRustEngine() {
  if (agentProcess) {
    agentProcess.stop();
    agentProcess = null;
  }
  napiEngine = null;
  engineMode = 'js';
}

// ── Session-owned agent API (phase D thin-client protocol, stdio only) ─────
// The Rust engine owns sessions, agents, goal driving, and persistence;
// this side only installs `host/*` handlers (LLM + tool lifecycle) and
// renders. Every call returns null when the stdio engine is unavailable.

export interface SessionHostHandlers {
  llmChat: (req: LlmChatRequest) => Promise<LlmChatResponse>;
  toolExecute: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>;
  prepareTool?: (req: PrepareToolRequest) => Promise<PrepareToolResponse | null>;
  authorizeTool?: (req: AuthorizeToolRequest) => Promise<AuthorizeToolResponse | null>;
  finalizeTool?: (req: FinalizeToolRequest) => Promise<FinalizeToolResponse>;
  onEvent?: (event: EngineEvent) => void;
}

/** Install the host callback handlers a session-owned agent calls back on. */
export function installSessionHostHandlers(handlers: SessionHostHandlers): boolean {
  const agent = getAgent();
  if (!agent) return false;
  agent.setLlmChatHandler(handlers.llmChat);
  agent.setToolExecuteHandler(handlers.toolExecute);
  if (handlers.prepareTool) agent.setPrepareToolHandler(handlers.prepareTool);
  if (handlers.authorizeTool) agent.setAuthorizeToolHandler(handlers.authorizeTool);
  if (handlers.finalizeTool) agent.setFinalizeToolHandler(handlers.finalizeTool);
  if (handlers.onEvent) agent.setEventHandler(handlers.onEvent);
  return true;
}

export interface SessionCreateOptions {
  sessionId?: string;
  homedir?: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  goalEnabled?: boolean;
  nativeLlm?: NativeLlmDef;
}

/** Create a session-owned agent inside the engine. */
export async function sessionCreate(
  options: SessionCreateOptions = {},
): Promise<{ session_id: string } | null> {
  return agentCall('session/create', {
    session_id: options.sessionId,
    homedir: options.homedir,
    system_prompt: options.systemPrompt,
    provider: options.provider,
    model: options.model,
    goal_enabled: options.goalEnabled,
    native_llm: options.nativeLlm,
  });
}

export interface SessionPromptResult {
  stop_reason: string;
  steps: number;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

/**
 * Run a prompt on a session-owned agent. Goal-aware: continuation turns run
 * inside the engine while a goal stays active.
 */
export async function sessionPrompt(
  sessionId: string,
  input: { type: 'text'; text: string }[],
): Promise<SessionPromptResult | null> {
  return agentCall('session/prompt', { session_id: sessionId, input });
}

/** Cancel a session's running turn (stops at the next step boundary). */
export async function sessionCancel(sessionId: string): Promise<{ cancelled: boolean } | null> {
  return agentCall('session/cancel', { session_id: sessionId });
}

/** Persist a session's full state (context history + goal). */
export async function sessionSave(sessionId: string): Promise<{ ok: boolean } | null> {
  return agentCall('session/save', { session_id: sessionId });
}

/** Restore a session's state; an `active` goal comes back `paused`. */
export async function sessionLoad(sessionId: string): Promise<{ found: boolean } | null> {
  return agentCall('session/load', { session_id: sessionId });
}

/** List persisted sessions (most recent first). */
export async function sessionList(
  limit?: number,
  offset?: number,
): Promise<{ sessions: unknown[] } | null> {
  return agentCall('session/list', { limit, offset });
}

// ── Cron RPC API ──────────────────────────────────────────────────────────────

export interface CronCreateResult {
  id: string;
  cron: string;
  prompt: string;
  created_at: number;
  recurring: boolean;
}

export interface CronTaskSnapshot {
  id: string;
  cron: string;
  recurring: boolean;
  created_at: number;
  last_fired_at?: number;
  next_fire_at?: number;
}

export interface CronListResult {
  tasks: CronTaskSnapshot[];
}

export interface CronDeleteResult {
  removed: string[];
}

export interface CronGetNextFireResult {
  next_fire_at?: number;
}

/**
 * Send a JSON-RPC request to the Rust agent (stdio or napi).
 * Falls back to `null` when the Rust engine is not available.
 */
async function agentCall<T = unknown>(method: string, params: unknown): Promise<T | null> {
  const mode = initEngine();
  if (mode === 'stdio') {
    const agent = getAgent();
    if (!agent) return null;
    return (await agent.request(method, params)) as T;
  }
  if (mode === 'napi') {
    // Napi mode: use the napi engine's RPC-like direct call.
    // The napi bridge currently only supports runTurnRust; for generic
    // RPC we fall through to stdio. If the napi engine is loaded but
    // no stdio binary is available, cron/background calls are not
    // available in pure-napi mode.
    console.warn('[kimi-agent] Napi mode does not support generic RPC; falling back to JS');
    return null;
  }
  return null;
}

/** Create a cron task. Returns null if the Rust engine is not available. */
export async function cronCreate(params: {
  cron: string;
  prompt: string;
  recurring?: boolean;
}): Promise<CronCreateResult | null> {
  return agentCall<CronCreateResult>('cron/create', params);
}

/** Delete cron tasks by id. Returns null if the Rust engine is not available. */
export async function cronDelete(ids: string[]): Promise<CronDeleteResult | null> {
  return agentCall<CronDeleteResult>('cron/delete', { ids });
}

/** List all cron tasks. Returns null if the Rust engine is not available. */
export async function cronList(): Promise<CronListResult | null> {
  return agentCall<CronListResult>('cron/list', {});
}

/** Get next fire time for a cron task. Returns null if the Rust engine is not available. */
export async function cronGetNextFire(taskId?: string): Promise<CronGetNextFireResult | null> {
  return agentCall<CronGetNextFireResult>('cron/get_next_fire', { task_id: taskId });
}

// ── Background task RPC API ───────────────────────────────────────────────────

export interface BgRegisterResult {
  task_id: string | null;
  error?: string | null;
}

export interface BgOutputResult {
  output_path?: string;
  output_size_bytes: number;
  preview_bytes: number;
  truncated: boolean;
  full_output_available: boolean;
  preview: string;
  error?: string;
}

/** Register a background task. Returns null if the Rust engine is not available. */
export async function bgRegister(params: {
  prefix: string;
  kind: 'process' | 'agent' | 'question';
  description: string;
  detached?: boolean;
  timeoutMs?: number;
}): Promise<BgRegisterResult | null> {
  return agentCall<BgRegisterResult>('bg/register', params);
}

/** List all background tasks. Returns null if the Rust engine is not available. */
export async function bgList(): Promise<unknown[] | null> {
  return agentCall<unknown[]>('bg/list', {});
}

/** Get a specific background task. Returns null if the Rust engine is not available. */
export async function bgGet(taskId: string): Promise<unknown> {
  return agentCall('bg/get', { task_id: taskId });
}

/** Stop a background task. Returns null if the Rust engine is not available. */
export async function bgStop(taskId: string, reason?: string): Promise<{ ok: boolean } | null> {
  return agentCall<{ ok: boolean }>('bg/stop', { task_id: taskId, reason });
}

/** Get output snapshot for a background task. Returns null if the Rust engine is not available. */
export async function bgOutput(taskId: string): Promise<BgOutputResult | null> {
  return agentCall<BgOutputResult>('bg/output', { task_id: taskId });
}

/** Append output to a background task. Returns null if the Rust engine is not available. */
export async function bgAppendOutput(
  taskId: string,
  chunk: string,
): Promise<{ ok: boolean } | null> {
  return agentCall<{ ok: boolean }>('bg/append_output', { task_id: taskId, chunk });
}

/** Settle (mark terminal) a background task. Returns null if the Rust engine is not available. */
export async function bgSettle(
  taskId: string,
  status: string,
  stopReason?: string,
): Promise<{ ok: boolean } | null> {
  return agentCall<{ ok: boolean }>('bg/settle', {
    task_id: taskId,
    status,
    stop_reason: stopReason,
  });
}

// ── Workspace prediction ──────────────────────────────────────────────────

/// Maximum file size for which we offer a prediction (100 KB).
/// Larger files skip the fast-path and execute precisely on the first call.
const PREDICTION_MAX_FILE_SIZE = 100 * 1024;

/// Number of preview lines included in the prediction.
const PREDICTION_PREVIEW_LINES = 5;

/**
 * Lightweight workspace file predictor for the Read tool fast-path.
 *
 * Instead of pre-scanning the entire workspace (like the Rust WorkspaceIndex),
 * this class checks individual files on-demand: stat + read first N lines.
 * This avoids the startup cost of building a full index while still
 * providing instant predictions for most Read calls.
 *
 * The prediction includes the first few lines with line numbers and a
 * note that it's a prediction — the precise result will replace it shortly.
 *
 * When the Rust `WorkspaceIndex` has been preheated (via
 * `nativeBuildWorkspaceIndex`), predictions are served from it first —
 * the on-demand JS stat path is only a fallback for files the index
 * missed (e.g. created after the index was built).
 */
export class WorkspacePredictor {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Generate a Read prediction for the given path.
   *
   * Tries the preheated Rust workspace index first (instant, no I/O on
   * the JS side). On miss, falls back to an on-demand stat + read of the
   * first N lines.
   *
   * Returns null when:
   *   - The file doesn't exist or is not a regular file
   *   - The file is too large (> 100 KB)
   *   - The file contains NUL bytes (binary)
   *   - fs/stat is not available (sandboxed environment)
   */
  predictRead(path: string): string | null {
    // 1) Try the preheated native workspace index first.
    const nativePrediction = tryNativeWorkspaceIndexPredictRead(path);
    if (nativePrediction !== undefined && nativePrediction !== null) {
      return this.formatNativePrediction(path, nativePrediction);
    }

    // 2) Fall back to on-demand JS stat + read.
    return this.predictReadViaFs(path);
  }

  /**
   * Format a native index prediction into the same shape as the JS path.
   */
  private formatNativePrediction(path: string, p: NativeReadPrediction): string {
    const previewLines = p.preview.split('\n').slice(0, PREDICTION_PREVIEW_LINES);
    const numbered = previewLines
      .map((line, i) => `${String(i + 1).padStart(6)}→${line}`)
      .join('\n');
    return (
      `cat ${path}  (prediction: ${p.lineCount} lines, ${p.size} bytes)\n` +
      `${numbered}\n` +
      `\n[... prediction — precise result loading ...]`
    );
  }

  /**
   * On-demand JS fallback: stat + read first N lines.
   */
  private predictReadViaFs(path: string): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = nodeRequire('node:fs') as typeof import('node:fs');

      const resolved = this.resolvePath(path);
      if (resolved === null) return null;

      const stat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) return null;
      if (stat.size > PREDICTION_MAX_FILE_SIZE) return null;
      if (stat.size === 0) return null;

      // Read first N lines
      const fd = fs.openSync(resolved, 'r');
      try {
        const buf = Buffer.alloc(Math.min(stat.size, 8192));
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const content = buf.subarray(0, bytesRead).toString('utf-8');

        // Binary detection: NUL byte
        if (content.includes('\0')) return null;

        const lines = content.split('\n');
        const previewLines = lines.slice(0, PREDICTION_PREVIEW_LINES);
        const numbered = previewLines
          .map((line, i) => `${String(i + 1).padStart(6)}→${line}`)
          .join('\n');

        const lineCount = stat.size > 0 ? this.estimateLineCount(resolved, stat.size) : 0;
        return (
          `cat ${path}  (prediction: ${lineCount} lines, ${stat.size} bytes)\n` +
          `${numbered}\n` +
          `\n[... prediction — precise result loading ...]`
        );
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  /**
   * Resolve a path relative to the workspace root.
   * Returns null if the path is outside the workspace.
   */
  private resolvePath(path: string): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = nodeRequire('node:path') as typeof import('node:path');
      const resolved = pathMod.isAbsolute(path) ? path : pathMod.resolve(this.root, path);
      return resolved;
    } catch {
      return null;
    }
  }

  /**
   * Quick line count estimate without reading the whole file.
   * Uses the average line length from the preview.
   */
  private estimateLineCount(filePath: string, fileSize: number): number {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = nodeRequire('node:fs') as typeof import('node:fs');
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(fileSize, 8192));
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const sample = buf.subarray(0, bytesRead).toString('utf-8');
        const sampleLines = sample.split('\n').length;
        const avgLineLength = bytesRead / sampleLines;
        return Math.ceil(fileSize / avgLineLength);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return 0;
    }
  }
}
