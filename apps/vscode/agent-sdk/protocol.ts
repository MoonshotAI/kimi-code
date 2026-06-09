import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { type StreamEvent, type RunResult, type ContentPart, type ParseError, type AgentMode, type ApprovalResult } from "./schema";
import { TransportError, CliError } from "./errors";
import { AcpLegacyEventTranslator, normalizeAcpMode, type AcpContentBlock, type AcpPermissionRequest, type AcpSessionNotification } from "./acp-legacy-events";

const MAX_DEBUG_PAYLOAD_LENGTH = 500;
const HANDSHAKE_TIMEOUT_MS = 10000;

function isDebugAcpEnabled(): boolean {
  return process.env.KIMI_CODE_DEBUG_ACP === "1";
}

function debugAcp(...args: unknown[]): void {
  if (isDebugAcpEnabled()) {
    console.log(...args);
  }
}

function debugAcpPayload(prefix: string, payload: string): void {
  if (isDebugAcpEnabled()) {
    console.log(prefix, truncateForDebug(payload));
  }
}

function debugAcpStderr(data: unknown): void {
  if (isDebugAcpEnabled()) {
    console.warn("[protocol-client stderr]", data instanceof Buffer ? data.toString() : String(data));
  }
}

function truncateForDebug(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= MAX_DEBUG_PAYLOAD_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_DEBUG_PAYLOAD_LENGTH)}...(${text.length} chars)`;
}

// Client Options
export interface ClientOptions {
  sessionId?: string;
  workDir: string;
  model?: string;
  thinking?: boolean;
  mode?: AgentMode;
  yoloMode?: boolean;
  executablePath?: string;
  environmentVariables?: Record<string, string>;
}

type AppliedConfig = Pick<ClientOptions, "model"> & {
  thinking: boolean;
  mode: AgentMode;
};

// Prompt Stream
export interface PromptStream {
  events: AsyncIterable<StreamEvent>;
  result: Promise<RunResult>;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

// Event Channel Helper
// Creates a push-based async iterable used for PromptStream. `push` adds
// events to a queue (or resolves a waiting consumer); `finish` signals EOF.
export function createEventChannel<T>(): {
  iterable: AsyncIterable<T>;
  push: (value: T) => void;
  finish: () => void;
} {
  const queue: T[] = [];
  const resolvers: Array<(result: IteratorResult<T>) => void> = [];
  let finished = false;

  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const queued = queue.shift();
          if (queued !== undefined) {
            return Promise.resolve({ done: false as const, value: queued });
          }
          if (finished) {
            return Promise.resolve({ done: true as const, value: undefined });
          }
          return new Promise((resolve) => resolvers.push(resolve));
        },
      }),
    },
    push: (value: T) => {
      if (finished) {
        return;
      }
      const resolver = resolvers.shift();
      if (resolver) {
        resolver({ done: false, value });
      } else {
        queue.push(value);
      }
    },
    finish: () => {
      if (finished) {
        return;
      }
      finished = true;
      for (const resolver of resolvers) {
        resolver({ done: true, value: undefined });
      }
      resolvers.length = 0;
    },
  };
}

// Protocol Client
export class ProtocolClient {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private requestId = 0;
  private pendingRequests = new Map<string, PendingRequest>();

  private pushEvent: ((event: StreamEvent) => void) | null = null;
  private finishEvents: (() => void) | null = null;
  private ready: Promise<void> | null = null;
  private acpSessionId: string | null = null;
  private readonly translator = new AcpLegacyEventTranslator();
  // Events emitted before a prompt stream consumer is attached (e.g. during
  // session handshake replay) are buffered here and replayed on the next stream.
  private bufferedEvents: StreamEvent[] = [];
  private appliedConfig: Partial<AppliedConfig> | null = null;

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  get sessionId(): string | null {
    return this.acpSessionId;
  }

  start(options: ClientOptions): void {
    if (this.process) {
      throw new TransportError("ALREADY_STARTED", "Client already started");
    }

    const executable = options.executablePath ?? "kimi";
    const args = ["acp"];

    debugAcp(`[protocol-client] Spawning ACP CLI: ${executable} ${args.join(" ")}`);

    try {
      this.process = spawn(executable, args, {
        cwd: options.workDir,
        env: { ...process.env, ...options.environmentVariables },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      throw new TransportError("SPAWN_FAILED", `Failed to spawn CLI: ${err}`, err);
    }

    if (!this.process.stdout || !this.process.stdin) {
      this.process.kill();
      this.process = null;
      throw new TransportError("SPAWN_FAILED", "Process missing stdio");
    }

    this.readline = createInterface({ input: this.process.stdout });
    this.readline.on("line", (line) => this.handleLine(line));

    this.process.stderr?.on("data", (data) => debugAcpStderr(data));
    this.process.on("error", (err) => this.handleProcessError(err));
    this.process.on("exit", (code) => this.handleProcessExit(code));

    this.ready = this.initialize(options);
  }

  async ensureReady(): Promise<string> {
    if (!this.ready) {
      throw new TransportError("SPAWN_FAILED", "Client is not started");
    }
    await this.ready;
    if (!this.acpSessionId) {
      throw new TransportError("HANDSHAKE_TIMEOUT", "ACP session was not initialized");
    }
    return this.acpSessionId;
  }

  consumeBufferedEvents(): StreamEvent[] {
    const events = this.bufferedEvents;
    this.bufferedEvents = [];
    return events;
  }

  async applyConfig(options: Pick<ClientOptions, "model" | "thinking" | "mode" | "yoloMode">): Promise<void> {
    await this.ensureReady();
    await this.applyConfigRaw(options);
  }

  private normalizeAppliedConfig(options: Pick<ClientOptions, "model" | "thinking" | "mode" | "yoloMode">): AppliedConfig {
    return {
      model: options.model,
      thinking: options.thinking ?? false,
      mode: normalizeMode(options),
    };
  }

  private markKnownConfigApplied(configOptions: unknown[] | undefined, _options: Pick<ClientOptions, "model" | "thinking" | "mode" | "yoloMode">): void {
    const knownConfig: Partial<AppliedConfig> = { ...(this.appliedConfig ?? {}) };

    for (const option of configOptions ?? []) {
      const id = getConfigOptionId(option);
      const value = getConfigOptionValue(option);

      if (id === "model" && typeof value === "string") {
        knownConfig.model = value;
      } else if (id === "thinking") {
        const thinking = parseBooleanConfigValue(value);
        if (thinking !== null) {
          knownConfig.thinking = thinking;
        }
      } else if (id === "mode") {
        const mode = parseModeConfigValue(value);
        if (mode) {
          knownConfig.mode = mode;
        }
      }
    }

    this.appliedConfig = Object.keys(knownConfig).length > 0 ? knownConfig : null;
  }

  private async applyConfigRaw(options: Pick<ClientOptions, "model" | "thinking" | "mode" | "yoloMode">): Promise<void> {
    if (!this.acpSessionId) {
      return;
    }
    const sessionId = this.acpSessionId;
    const config = this.normalizeAppliedConfig(options);
    const appliedConfig = this.appliedConfig;

    if (config.model && appliedConfig?.model !== config.model) {
      await this.sendRequest(
        "session/set_config_option",
        {
          sessionId,
          configId: "model",
          value: config.model,
        },
        HANDSHAKE_TIMEOUT_MS,
      );
    }
    if (appliedConfig?.thinking !== config.thinking) {
      await this.sendRequest(
        "session/set_config_option",
        {
          sessionId,
          configId: "thinking",
          value: config.thinking ? "on" : "off",
        },
        HANDSHAKE_TIMEOUT_MS,
      );
    }
    if (appliedConfig?.mode !== config.mode) {
      await this.sendRequest(
        "session/set_config_option",
        {
          sessionId,
          configId: "mode",
          value: config.mode,
        },
        HANDSHAKE_TIMEOUT_MS,
      );
    }

    this.appliedConfig = appliedConfig ? { ...appliedConfig, ...config } : config;
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    if (this.process.exitCode !== null || this.process.killed) {
      this.cleanup();
      return;
    }

    this.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill("SIGKILL");
        resolve();
      }, 3000);
      this.process!.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.cleanup();
  }

  sendPrompt(content: string | ContentPart[]): PromptStream {
    const { iterable, push, finish } = createEventChannel<StreamEvent>();

    this.pushEvent = push;
    this.finishEvents = () => {
      finish();
      this.pushEvent = null;
      this.finishEvents = null;
    };

    push({ type: "TurnBegin", payload: { user_input: content } });
    push({ type: "StepBegin", payload: { n: 1 } });

    const result = this.ensureReady()
      .then((sessionId) =>
        this.sendRequest("session/prompt", {
          sessionId,
          prompt: toAcpPrompt(content),
        }),
      )
      .then((res) => {
        this.finishEvents?.();
        const stopReason = (res as { stopReason?: string } | undefined)?.stopReason;
        return runResultFromStopReason(stopReason);
      })
      .catch((err) => {
        this.finishEvents?.();
        throw err;
      });

    return { events: iterable, result };
  }

  sendCancel(): Promise<void> {
    if (!this.acpSessionId) {
      return Promise.resolve();
    }
    this.writeLine({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.acpSessionId } });
    return Promise.resolve();
  }

  sendApproval(requestId: string | number, response: ApprovalResult): Promise<void> {
    const optionId = typeof response === "string" ? (response === "approve" ? "approve_once" : response === "approve_for_session" ? "approve_always" : "reject") : response.optionId;
    this.writeLine({
      jsonrpc: "2.0",
      id: requestId,
      result: { outcome: { outcome: "selected", optionId } },
    });
    this.emitEvent({ type: "ApprovalRequestResolved", payload: { request_id: requestId, response } });
    return Promise.resolve();
  }

  private async initialize(options: ClientOptions): Promise<void> {
    await this.sendRequest(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      },
      HANDSHAKE_TIMEOUT_MS,
    );

    if (options.sessionId) {
      const res = await this.sendRequest(
        "session/load",
        {
          cwd: options.workDir,
          sessionId: options.sessionId,
          mcpServers: [],
        },
        HANDSHAKE_TIMEOUT_MS,
      );
      this.acpSessionId = options.sessionId;
      const configOptions = extractConfigOptions(res);
      this.markKnownConfigApplied(configOptions, options);
      this.emitConfigOptionUpdate(configOptions);
    } else {
      const res = (await this.sendRequest(
        "session/new",
        {
          cwd: options.workDir,
          mcpServers: [],
        },
        HANDSHAKE_TIMEOUT_MS,
      )) as { sessionId?: string; configOptions?: unknown[] };
      if (!res?.sessionId) {
        throw new TransportError("HANDSHAKE_TIMEOUT", "ACP session/new did not return sessionId");
      }
      this.acpSessionId = res.sessionId;
      const configOptions = extractConfigOptions(res);
      this.markKnownConfigApplied(configOptions, options);
      this.emitConfigOptionUpdate(configOptions);
      await this.applyConfigRaw(options);
    }
  }

  // Private: RPC Communication
  private sendRequest(method: string, params?: any, timeoutMs?: number): Promise<unknown> {
    const id = `${++this.requestId}_${Date.now()}`;

    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const timeoutHandler = timeoutMs
        ? () => {
            this.pendingRequests.delete(id);
            reject(new TransportError("HANDSHAKE_TIMEOUT", `RPC ${method} timed out after ${timeoutMs}ms`));
            this.stop();
          }
        : undefined;

      const wrappedResolve = (value: unknown) => {
        if (timeout) clearTimeout(timeout);
        resolve(value);
      };
      const wrappedReject = (err: Error) => {
        if (timeout) clearTimeout(timeout);
        reject(err);
      };

      this.pendingRequests.set(id, { resolve: wrappedResolve, reject: wrappedReject });

      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(timeoutHandler!, timeoutMs);
      }

      try {
        this.writeLine({ jsonrpc: "2.0", id, method, ...(params && { params }) });
      } catch (err) {
        if (timeout) clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  private writeLine(data: unknown): void {
    const payload = JSON.stringify(data);
    debugAcpPayload("[protocol-client] Sending:", payload);

    if (!this.process?.stdin?.writable) {
      throw new TransportError("STDIN_NOT_WRITABLE", "Cannot write to CLI stdin");
    }
    this.process.stdin.write(payload + "\n");
  }

  // Private: Line Handling
  private handleLine(line: string): void {
    debugAcpPayload("[protocol-client] Received:", line);

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emitParseError("INVALID_JSON", "Failed to parse JSON", line);
      return;
    }

    const msg = parsed as { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

    if (msg.id !== undefined && this.pendingRequests.has(String(msg.id))) {
      const pending = this.pendingRequests.get(String(msg.id))!;
      this.pendingRequests.delete(String(msg.id));

      if (msg.error) {
        const detail = formatRpcError(msg.error);
        pending.reject(CliError.fromRpcError(msg.error.code, detail));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      this.handleNotificationOrRequest(msg.id, msg.method, msg.params);
    }
  }

  private handleNotificationOrRequest(id: string | number | undefined, method: string, params: unknown): void {
    if (method === "session/update") {
      this.handleSessionUpdate(params as AcpSessionNotification);
      return;
    }

    if (method === "kimi/conversation_reset") {
      this.emitEvent({ type: "ConversationReset", payload: {} });
      return;
    }

    if (method === "kimi/step_interrupted" || method === "kimi/compaction" || method === "kimi/subagent_event") {
      for (const event of this.translator.extensionNotificationToEvents(method, params)) {
        this.emitEvent(event);
      }
      return;
    }

    // ACP permission request ids are JSON-RPC request ids and can be number 0,
    // so we must check against undefined rather than a truthy test.
    if (method === "session/request_permission" && id !== undefined) {
      this.handlePermissionRequest(id, params as AcpPermissionRequest);
      return;
    }
  }

  private handleSessionUpdate(notification: AcpSessionNotification): void {
    for (const event of this.translator.sessionUpdateToEvents(notification, {
      suppressUserEcho: this.pushEvent !== null,
      onUnknownSessionUpdate: (update) => debugAcp("[protocol-client] Ignoring unknown ACP session/update", update.sessionUpdate),
    })) {
      this.emitEvent(event);
    }
  }

  private handlePermissionRequest(id: string | number, request: AcpPermissionRequest): void {
    this.emitEvent(this.translator.permissionRequestToEvent(id, request));
  }

  private emitParseError(code: string, message: string, raw?: string): void {
    const error: ParseError = { type: "error", code, message, raw: raw?.slice(0, 500) };
    this.emitEvent(error);
  }

  private emitEvent(event: StreamEvent): void {
    if (this.pushEvent) {
      this.pushEvent(event);
    } else {
      this.bufferedEvents.push(event);
    }
  }

  private emitConfigOptionUpdate(configOptions: unknown[] | undefined): void {
    const options = (configOptions ?? []).filter((option): option is Record<string, unknown> => option !== null && typeof option === "object" && !Array.isArray(option));
    if (options.length === 0) {
      return;
    }
    this.emitEvent({ type: "ConfigOptionUpdate", payload: { configOptions: options } });
  }

  // Private: Process Lifecycle
  private handleProcessError(err: Error): void {
    console.error("[protocol-client] Process error:", err.message);

    const error = new TransportError("PROCESS_CRASHED", `CLI process error: ${err.message}`, err);
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.finishEvents?.();
    this.cleanup();
  }

  private handleProcessExit(code: number | null): void {
    debugAcp("[protocol-client] Process exited with code:", code);

    if (this.pendingRequests.size > 0) {
      const error = new TransportError("PROCESS_CRASHED", `CLI exited with code ${code ?? "unknown"}`);
      for (const pending of this.pendingRequests.values()) {
        pending.reject(error);
      }
    }
    this.finishEvents?.();
    this.cleanup();
  }

  private cleanup(): void {
    this.readline?.removeAllListeners();
    this.readline?.close();
    this.readline = null;

    this.process?.removeAllListeners();
    this.process?.stdout?.removeAllListeners();
    this.process?.stderr?.removeAllListeners();
    this.process = null;

    this.pushEvent = null;
    this.finishEvents = null;
    this.pendingRequests.clear();
    this.ready = null;
    this.acpSessionId = null;
    this.appliedConfig = null;
    this.translator.reset();
    this.bufferedEvents = [];
  }
}

function extractConfigOptions(result: unknown): unknown[] | undefined {
  if (!result || typeof result !== "object" || !("configOptions" in result)) {
    return undefined;
  }
  const configOptions = result.configOptions;
  return Array.isArray(configOptions) ? configOptions : undefined;
}

function getConfigOptionId(option: unknown): string | null {
  if (!option || typeof option !== "object") {
    return null;
  }
  const record = option as Record<string, unknown>;
  const id = record.configId ?? record.optionId ?? record.id ?? record.name;
  return typeof id === "string" ? id : null;
}

function getConfigOptionValue(option: unknown): unknown {
  if (!option || typeof option !== "object") {
    return undefined;
  }
  const record = option as Record<string, unknown>;
  return record.value ?? record.currentValue ?? record.defaultValue;
}

function parseBooleanConfigValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  if (value === "on" || value === "true" || value === "enabled") {
    return true;
  }
  if (value === "off" || value === "false" || value === "disabled") {
    return false;
  }
  return null;
}

function parseModeConfigValue(value: unknown): AgentMode | null {
  if (value === "default" || value === "plan" || value === "auto" || value === "yolo") {
    return value;
  }
  return null;
}

function toAcpPrompt(content: string | ContentPart[]): AcpContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  const blocks: AcpContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) {
        blocks.push({ type: "image", mimeType: parsed.mimeType, data: parsed.data });
      } else {
        blocks.push({ type: "text", text: `<image url="${part.image_url.url}" />` });
      }
    } else if (part.type === "audio_url") {
      blocks.push({ type: "text", text: `<audio url="${part.audio_url.url}" />` });
    } else if (part.type === "video_url") {
      blocks.push({ type: "text", text: `<video url="${part.video_url.url}" />` });
    }
  }
  return blocks;
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], data: match[2] };
}

function normalizeMode(options: Pick<ClientOptions, "mode" | "yoloMode">): AgentMode {
  return normalizeAcpMode(options);
}

function runResultFromStopReason(stopReason: string | undefined): RunResult {
  if (stopReason === "cancelled") {
    return { status: "cancelled" };
  }
  if (stopReason === "max_turn_requests" || stopReason === "max_steps" || stopReason === "max_steps_reached") {
    return { status: "max_steps_reached" };
  }
  return { status: "finished" };
}

function formatRpcError(error: { message: string; data?: unknown }): string {
  const details = typeof error.data === "object" && error.data && "details" in error.data ? String((error.data as { details?: unknown }).details) : "";
  return details ? `${error.message}: ${details}` : error.message;
}
