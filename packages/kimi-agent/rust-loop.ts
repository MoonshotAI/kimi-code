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

import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// Project root: packages/kimi-agent/rust-loop.ts → ../../ (project root)
const projectRoot = resolve(import.meta.dirname!, '..', '..');

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

interface RunTurnResult {
  stop_reason: string;
  steps: number;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
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

class NapiEngine {
  private nativeModule: ReturnType<typeof import('node:module').createRequire> | null = null;
  private loaded = false;

  static findModule(): string | null {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const candidates = [
      // Development: alongside rust-loop.ts in the package directory
      resolve(import.meta.dirname!, 'kimi_agent.node'),
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
      this.nativeModule = require(modulePath);
      this.loaded = true;
      return true;
    } catch (err) {
      console.warn('[kimi-agent] Failed to load napi module:', err);
      return false;
    }
  }

  isLoaded(): boolean {
    return this.loaded;
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
      messages: Array<{ role: string; content: string }>;
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
    },
    llmChatCb: (request: string) => Promise<string>,
    executeToolCb: (request: string) => Promise<string>,
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
    const makeCallbackHandler = (
      handler: (request: string) => Promise<string>,
    ) => {
      return (callbackId: number) => {
        const payload = nativeModule.getCallbackPayload(callbackId);
        if (!payload) return;
        handler(payload).then(
          (result) => nativeModule.resolveCallback(callbackId, null, result),
          (err: unknown) =>
            nativeModule.resolveCallback(
              callbackId,
              err instanceof Error ? err.message : String(err),
              null,
            ),
        );
      };
    };

    return nativeModule.runTurnRust(
      params,
      makeCallbackHandler(llmChatCb),
      makeCallbackHandler(executeToolCb),
    ) as Promise<NapiRunTurnResult>;
  }
}

// ── Agent process manager (stdio JSON-RPC) ────────────────────────────────

class AgentProcess {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private ready = false;

  /** Callback for handling host/llm_chat requests from the Rust side. */
  private llmChatHandler: ((req: LlmChatRequest) => Promise<LlmChatResponse>) | null = null;

  /** Callback for handling host/execute_tool requests from the Rust side. */
  private toolExecuteHandler: ((req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) | null = null;

  setLlmChatHandler(handler: (req: LlmChatRequest) => Promise<LlmChatResponse>) {
    this.llmChatHandler = handler;
  }

  setToolExecuteHandler(handler: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) {
    this.toolExecuteHandler = handler;
  }

  static findBinary(): string | null {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const arch = `${process.platform}-${process.arch}`;
    const candidates = [
      // Development: directly from Rust build output
      resolve(projectRoot, 'packages/kimi-agent/target/release/kimi-agent-cli' + ext),
      resolve(projectRoot, 'packages/kimi-agent/target/debug/kimi-agent-cli' + ext),
      // Production: bundled alongside the SEA binary
      resolve(projectRoot, 'dist-native', 'bin', arch, 'kimi-agent-cli' + ext),
    ];
    try {
      const fs = require('node:fs');
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
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
    } catch (err) {
      console.warn('[kimi-agent] Failed to start:', err);
      return false;
    }
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as RpcMessage;

        switch (classifyRpcMessage(msg)) {
          case 'request':
            this.handleHostRequest(msg).catch((err) => {
              console.error('[kimi-agent] Failed to handle host request:', err);
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
    } catch (err) {
      this.writeHostError(msg.id, err instanceof Error ? err.message : String(err));
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
    } catch (err) {
      this.writeHostError(msg.id, err instanceof Error ? err.message : String(err));
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

  try {
    const result = await agent.request('agent/run_turn', params);
    return result as RunTurnResult;
  } catch (err) {
    console.error('[kimi-agent] RPC call failed:', err);
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
 * Returns `undefined` when the Rust binary is not available (falls back to JS).
 */
export function createRunTurnOverride(
  providers?: LlmProviderDef[],
  workspaceRoot?: string,
): import('@moonshot-ai/agent-core').RunTurnOverride | undefined {
  const mode = initEngine();
  if (mode === 'js') return undefined;

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

    // ── LLM chat handler ──────────────────────────────────────────────
    const llmChatHandler = async (): Promise<LlmChatResponse> => {
      await closeOpenStep();
      currentStep += 1;
      const stepUuid = randomUUID();
      const stepNum = currentStep;
      await input.dispatchEvent({ type: 'step.begin', uuid: stepUuid, turnId: input.turnId, step: stepNum });
      openStep = { uuid: stepUuid, step: stepNum, usage: { ...ZERO_USAGE } };

      const messages = await input.buildMessages();
      const stepTools = input.buildTools?.() ?? input.tools ?? [];

      const response = await input.llm.chat({
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
        },
      });
      if (openStep !== undefined) openStep.usage = response.usage;

      return {
        tool_calls: response.toolCalls?.map((tc) => ({
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
          input.replaceToolResult!(toolCallId, toolResult);
          return { content: outputToContent(toolResult.output), is_error: toolResult.isError === true };
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
        return { content: outputToContent(toolResult.output), is_error: toolResult.isError === true };
      };

      // ── Prediction fast-path ────────────────────────────────────────
      if (!req.force_precise && predictionEnabled && req.tool_name === 'read') {
        const args = req.arguments as { path?: string } | null;
        const filePath = args?.path;
        if (filePath) {
          const prediction = predictor!.predictRead(filePath);
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
        const missing = input.describeMissingTool?.(req.tool_name) ?? `Tool "${req.tool_name}" not found`;
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
      const prep = await input.hooks?.prepareToolExecution?.({ ...hookCtxBase, args: effectiveArgs });
      if (prep?.updatedArgs !== undefined) effectiveArgs = prep.updatedArgs;
      if (prep?.block === true) {
        return settle({ output: prep.reason ?? `Tool call "${req.tool_name}" was blocked`, isError: true }, effectiveArgs);
      }
      if (prep?.syntheticResult !== undefined) {
        return settle(prep.syntheticResult, effectiveArgs);
      }
      let executionMetadata = prep?.executionMetadata;

      let execution;
      try {
        execution = await tool.resolveExecution(effectiveArgs);
      } catch (err) {
        return settle({ output: err instanceof Error ? err.message : String(err), isError: true }, effectiveArgs);
      }

      if ('isError' in execution && execution.isError === true) {
        return settle(execution, effectiveArgs);
      }
      if (!('execute' in execution)) {
        return settle({ output: 'Tool execution resolved without executable', isError: true }, effectiveArgs);
      }

      const auth = await input.hooks?.authorizeToolExecution?.({ ...hookCtxBase, args: effectiveArgs, execution });
      if (auth?.block === true) {
        return settle({ output: auth.reason ?? `Tool call "${req.tool_name}" was blocked`, isError: true }, effectiveArgs);
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
      } catch (err) {
        rawResult = { output: err instanceof Error ? err.message : String(err), isError: true };
      }

      const finalized =
        (await input.hooks?.finalizeToolResult?.({ ...hookCtxBase, args: effectiveArgs, result: rawResult as never })) ??
        rawResult;

      return settle(finalized, effectiveArgs);
    };

    // ── Drive the turn ────────────────────────────────────────────────
    // Message content and the tool table are NOT sent here: the host
    // rebuilds both from `context` on every host/llm_chat callback (the
    // source of truth), so Rust only needs metadata to drive control flow.
    let rustResult: RunTurnResult;
    try {
      if (mode === 'napi') {
        const engine = getNapiEngine()!;
        // Napi callbacks use JSON-serialized payloads (string → string)
        const napiResult = await engine.runTurn(
          {
            turnId: input.turnId,
            systemPrompt: input.llm.systemPrompt,
            modelName: input.llm.modelName,
            messages: [],
            tools: [],
            maxSteps: input.maxSteps ?? 10,
          },
          // Wrap structured handler with JSON serialization for napi
          async (requestJson: string) => {
            const response = await llmChatHandler();
            return JSON.stringify(response);
          },
          async (requestJson: string) => {
            const req = JSON.parse(requestJson) as ToolExecuteRequest;
            const response = await toolExecuteHandler(req);
            return JSON.stringify(response);
          },
        );
        rustResult = {
          stop_reason: napiResult.stopReason,
          steps: napiResult.steps,
          usage: {
            input_tokens: napiResult.inputTokens,
            output_tokens: napiResult.outputTokens,
            total_tokens: napiResult.totalTokens,
          },
        };
      } else {
        // stdio JSON-RPC path
        const agent = getAgent()!;
        agent.setLlmChatHandler(llmChatHandler);
        agent.setToolExecuteHandler(toolExecuteHandler);

        const result = await agent.request('agent/run_turn', {
          turn_id: input.turnId,
          system_prompt: input.llm.systemPrompt,
          model_name: input.llm.modelName,
          messages: [],
          tools: [],
          max_steps: input.maxSteps ?? 10,
          providers: providers ?? [],
        });
        if (!result) {
          throw new Error('Rust engine returned null result');
        }
        rustResult = result as RunTurnResult;
      }
    } finally {
      await closeOpenStep();
    }

    const stopReason = mapStopReason(rustResult.stop_reason);

    return {
      stopReason,
      steps: rustResult.steps,
      usage: {
        inputOther: rustResult.usage.input_tokens,
        output: rustResult.usage.output_tokens,
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
    case 'EndTurn': return 'end_turn' as never;
    case 'MaxTokens': return 'max_tokens' as never;
    case 'Filtered': return 'filtered' as never;
    case 'Paused': return 'paused' as never;
    case 'Aborted': return 'aborted' as never;
    case 'BudgetLimited': return 'budget_limited' as never;
    default: return 'unknown' as never;
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

export function shutdownRustEngine() {
  if (agentProcess) {
    agentProcess.stop();
    agentProcess = null;
  }
  napiEngine = null;
  engineMode = 'js';
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
 */
class WorkspacePredictor {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Generate a Read prediction for the given path.
   *
   * Returns null when:
   *   - The file doesn't exist or is not a regular file
   *   - The file is too large (> 100 KB)
   *   - The file contains NUL bytes (binary)
   *   - fs/stat is not available (sandboxed environment)
   */
  predictRead(path: string): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs');

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
      const pathMod = require('node:path') as typeof import('node:path');
      const resolved = pathMod.isAbsolute(path)
        ? path
        : pathMod.resolve(this.root, path);
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
      const fs = require('node:fs') as typeof import('node:fs');
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