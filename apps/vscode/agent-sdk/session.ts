import * as crypto from "node:crypto";
import { ProtocolClient } from "./protocol";
import { SessionError } from "./errors";
import type { SessionOptions, ContentPart, StreamEvent, RunResult, ApprovalResult, AgentMode } from "./schema";

export type SessionState = "idle" | "active" | "closed";

/** 当前生效的配置快照 */
interface ActiveConfig {
  sessionId: string | undefined;
  model: string | undefined;
  thinking: boolean;
  mode: AgentMode;
  executable: string;
  env: string; // JSON stringified for comparison
}

/** Turn 接口，代表一次对话轮次 */
export interface Turn {
  /** 异步迭代事件流，迭代完成后返回 RunResult */
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent, RunResult, undefined>;
  /** 中断当前轮次，清空消息队列 */
  interrupt(): Promise<void>;
  /** 响应审批请求（ACP 的 JSON-RPC id 可能是 number 且从 0 起，需原样回写） */
  approve(requestId: string | number, response: ApprovalResult): Promise<void>;
  /** 轮次完成后的结果 Promise */
  readonly result: Promise<RunResult>;
}

/** Session 接口，代表一个与 Kimi Code 的持久连接 */
export interface Session {
  /** 会话 ID */
  readonly sessionId: string;
  /** 工作目录 */
  readonly workDir: string;
  /** 当前状态：idle | active | closed */
  readonly state: SessionState;
  /** 模型 ID，可在轮次间修改 */
  model: string | undefined;
  /** 是否启用思考模式，可在轮次间修改 */
  thinking: boolean;
  /** ACP execution mode，可在轮次间修改 */
  mode: AgentMode;
  /** 是否自动批准操作，可在轮次间修改 */
  yoloMode: boolean;
  /** CLI 可执行文件路径，可在轮次间修改 */
  executable: string;
  /** 环境变量，可在轮次间修改 */
  env: Record<string, string>;
  /** 发送消息，返回 Turn 对象 */
  prompt(content: string | ContentPart[]): Turn;
  /** 取消当前回复但保留已排队消息，下一排队消息立即发送 */
  steer(): Promise<void>;
  /** 确保 ACP 会话已创建 / 加载，并同步真实 sessionId */
  ensureStarted(): Promise<void>;
  /** 立即把当前 model/thinking/mode 通过 set_config_option 热更新到运行中的会话（可在轮次进行中调用）；进程未运行时为 no-op */
  applyConfigNow(): Promise<void>;
  /** 取出启动 / 加载会话时 ACP replay 产生的事件 */
  consumeBufferedEvents(): StreamEvent[];
  /** 关闭会话，释放资源 */
  close(): Promise<void>;
  /** 支持 using 语法自动关闭 */
  [Symbol.asyncDispose](): Promise<void>;
}

class TurnImpl implements Turn {
  readonly result: Promise<RunResult>;
  private resolveResult!: (result: RunResult) => void;
  private rejectResult!: (error: Error) => void;
  private interrupted = false;

  constructor(
    private getClient: () => Promise<ProtocolClient>,
    private getCurrentClient: () => ProtocolClient | null,
    private getNextPending: () => (string | ContentPart[]) | undefined,
    private clearPending: () => void,
    private onComplete: () => void,
  ) {
    const promise = new Promise<RunResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    this.result = promise;
    promise.catch(() => {});
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent, RunResult, undefined> {
    try {
      let result: RunResult | undefined;
      let content: string | ContentPart[] | undefined;
      while (!this.interrupted && (content = this.getNextPending()) !== undefined) {
        result = yield* this.processOne(content);
      }
      this.onComplete();
      this.resolveResult(result!);
      return result!;
    } catch (err) {
      this.onComplete();
      this.rejectResult(err as Error);
      throw err;
    }
  }

  private async *processOne(content: string | ContentPart[]): AsyncGenerator<StreamEvent, RunResult, undefined> {
    const client = await this.getClient();
    const stream = client.sendPrompt(content);
    for await (const event of stream.events) {
      yield event;
    }
    return await stream.result;
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.clearPending();
    const client = this.getCurrentClient();
    if (client?.isRunning) {
      return client.sendCancel();
    }
  }

  async approve(requestId: string | number, response: ApprovalResult): Promise<void> {
    const client = this.getCurrentClient();
    if (!client?.isRunning) {
      throw new SessionError("SESSION_CLOSED", "Cannot approve: no active client");
    }
    return client.sendApproval(requestId, response);
  }
}

class SessionImpl implements Session {
  private _sessionId: string | undefined;
  private readonly _initialSessionId: string | undefined;
  private readonly _workDir: string;
  private _model: string | undefined;
  private _thinking: boolean;
  private _mode: AgentMode;
  private _executable: string;
  private _env: Record<string, string>;
  private _state: SessionState = "idle";

  private client: ProtocolClient | null = null;
  private activeConfig: ActiveConfig | null = null;
  private getClientWithConfigCheckPromise: Promise<ProtocolClient> | null = null;
  private currentTurn: TurnImpl | null = null;
  private pendingMessages: (string | ContentPart[])[] = [];

  constructor(options: SessionOptions) {
    // Keep the user-supplied sessionId so we can choose session/load vs
    // session/new when starting the ACP handshake. A placeholder random UUID
    // is generated only for local identity before the handshake completes.
    this._initialSessionId = options.sessionId;
    this._sessionId = options.sessionId ?? crypto.randomUUID();
    this._workDir = options.workDir;
    this._model = options.model;
    this._thinking = options.thinking ?? false;
    this._mode = normalizeMode(options.mode, options.yoloMode);
    this._executable = options.executable ?? "kimi";
    this._env = options.env ?? {};
  }

  get sessionId(): string {
    return this._sessionId ?? "";
  }
  get workDir(): string {
    return this._workDir;
  }
  get state(): SessionState {
    return this._state;
  }
  get model(): string | undefined {
    return this._model;
  }
  set model(v: string | undefined) {
    this._model = v;
  }
  get thinking(): boolean {
    return this._thinking;
  }
  set thinking(v: boolean) {
    this._thinking = v;
  }
  get mode(): AgentMode {
    return this._mode;
  }
  set mode(v: AgentMode) {
    this._mode = normalizeMode(v);
  }
  get yoloMode(): boolean {
    return this._mode === "yolo";
  }
  set yoloMode(v: boolean) {
    this._mode = v ? "yolo" : "default";
  }
  get executable(): string {
    return this._executable;
  }
  set executable(v: string) {
    this._executable = v;
  }
  get env(): Record<string, string> {
    return this._env;
  }
  set env(v: Record<string, string>) {
    this._env = v;
  }

  prompt(content: string | ContentPart[]): Turn {
    if (this._state === "closed") {
      throw new SessionError("SESSION_CLOSED", "Session is closed");
    }

    this.pendingMessages.push(content);

    if (this._state === "active" && this.currentTurn) {
      return this.currentTurn;
    }

    this._state = "active";
    this.currentTurn = new TurnImpl(
      () => this.getClientWithConfigCheck(),
      () => this.client,
      () => this.pendingMessages.shift(),
      () => {
        this.pendingMessages = [];
      },
      () => {
        if (this._state === "active") {
          this._state = "idle";
        }
        this.currentTurn = null;
      },
    );

    return this.currentTurn;
  }

  async steer(): Promise<void> {
    if (this._state !== "active" || !this.currentTurn || !this.client?.isRunning || this.pendingMessages.length === 0) {
      return;
    }

    await this.client.sendCancel();
  }

  async close(): Promise<void> {
    if (this._state === "closed") {
      return;
    }
    this._state = "closed";
    this.currentTurn = null;
    this.pendingMessages = [];
    this.getClientWithConfigCheckPromise = null;

    if (this.client) {
      try {
        await this.client.stop();
      } catch (err) {
        console.warn("[session] Error during close:", err);
      }
      this.client = null;
      this.activeConfig = null;
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async ensureStarted(): Promise<void> {
    const client = await this.getClientWithConfigCheck();
    if (typeof client.ensureReady === "function") {
      await client.ensureReady();
    }
    const sessionId = "sessionId" in client ? client.sessionId : null;
    if (sessionId) {
      this._sessionId = sessionId;
    }
  }

  consumeBufferedEvents(): StreamEvent[] {
    return this.client?.consumeBufferedEvents() ?? [];
  }

  async applyConfigNow(): Promise<void> {
    if (!this.client?.isRunning || typeof this.client.applyConfig !== "function") {
      return;
    }
    await this.client.applyConfig({
      model: this._model,
      thinking: this._thinking,
      mode: this._mode,
    });
    this.activeConfig = this.snapshotConfig();
  }

  private async getClientWithConfigCheck(): Promise<ProtocolClient> {
    if (!this.getClientWithConfigCheckPromise) {
      this.getClientWithConfigCheckPromise = this.doGetClientWithConfigCheck().finally(() => {
        this.getClientWithConfigCheckPromise = null;
      });
    }
    return this.getClientWithConfigCheckPromise;
  }

  private async doGetClientWithConfigCheck(): Promise<ProtocolClient> {
    const currentConfig = this.snapshotConfig();

    if (this.client?.isRunning && this.activeConfig && !this.needsRestart(currentConfig)) {
      if (this.configChanged(currentConfig)) {
        if (typeof this.client.applyConfig === "function") {
          await this.client.applyConfig({
            model: this._model,
            thinking: this._thinking,
            mode: this._mode,
          });
        }
        this.activeConfig = currentConfig;
      }
      return this.client;
    }

    // Config changed or no client, restart
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }

    this.client = new ProtocolClient();
    this.client.start({
      sessionId: this._initialSessionId ? this._sessionId : undefined,
      workDir: this._workDir,
      model: this._model,
      thinking: this._thinking,
      mode: this._mode,
      executablePath: this._executable,
      environmentVariables: this._env,
    });
    this.activeConfig = currentConfig;
    if (typeof this.client.ensureReady === "function") {
      await this.client.ensureReady();
    }
    const clientSessionId = "sessionId" in this.client ? this.client.sessionId : null;
    if (clientSessionId) {
      this._sessionId = clientSessionId;
      this.activeConfig = this.snapshotConfig();
    }

    return this.client;
  }

  private snapshotConfig(): ActiveConfig {
    return {
      sessionId: this._sessionId,
      model: this._model,
      thinking: this._thinking,
      mode: this._mode,
      executable: this._executable,
      env: JSON.stringify(this._env),
    };
  }

  private configChanged(current: ActiveConfig): boolean {
    const active = this.activeConfig!;
    return (
      current.sessionId !== active.sessionId ||
      current.model !== active.model ||
      current.thinking !== active.thinking ||
      current.mode !== active.mode ||
      current.executable !== active.executable ||
      current.env !== active.env
    );
  }

  private needsRestart(current: ActiveConfig): boolean {
    const active = this.activeConfig!;
    return current.sessionId !== active.sessionId || current.executable !== active.executable || current.env !== active.env;
  }
}

/** Start New Session */
export function createSession(options: SessionOptions): Session {
  return new SessionImpl(options);
}

function normalizeMode(mode?: AgentMode, yoloMode?: boolean): AgentMode {
  if (mode === "default" || mode === "plan" || mode === "auto" || mode === "yolo") {
    return mode;
  }
  return yoloMode ? "yolo" : "default";
}

/** One-time run: create session, send message, collect all events, and automatically close session after returning result */
export async function prompt(content: string | ContentPart[], options: Omit<SessionOptions, "sessionId">): Promise<{ result: RunResult; events: StreamEvent[] }> {
  const session = createSession(options);
  try {
    const turn = session.prompt(content);
    const events: StreamEvent[] = [];
    for await (const event of turn) {
      events.push(event);
    }
    return { result: await turn.result, events };
  } finally {
    await session.close();
  }
}
