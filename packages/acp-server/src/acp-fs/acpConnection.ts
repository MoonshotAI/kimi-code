/**
 * ACP client connection bridge — App-scope holder for the process-wide ACP
 * client connection used by the ACP-backed `IHostFileSystem` to reverse-RPC
 * file text reads/writes to the editor (ACP `fs.readTextFile` /
 * `fs.writeTextFile`) and by the ACP-backed `ISessionProcessRunner` to
 * reverse-RPC command execution (`terminal/create` … `terminal/release`).
 *
 * One ACP client connection exists per `acp-server` process (a single stdio
 * connection, multiplexed by `sessionId`); it is established after
 * `bootstrap()`, so it is bound here lazily via {@link IAcpConnection.bind}
 * rather than seeded at composition time. The ACP-backed `IHostFileSystem`
 * (Session scope) and the ACP-backed process runner (Agent scope) read it on
 * first use through {@link IAcpConnection.get}.
 */

import {
  createDecorator,
  LifecycleScope,
  registerScopedService,
  ScopeActivation,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';

/**
 * Narrow ACP-client file surface the ACP-backed `IHostFileSystem` needs.
 *
 * Implemented by `../acp-client`'s `AcpClient` (the app-API outbound
 * adapter), so the host can `bind(client)` directly without a further
 * adapter.
 */
export interface IAcpFsClient {
  readTextFile(params: {
    readonly sessionId: string;
    readonly path: string;
  }): Promise<{ readonly content: string }>;
  writeTextFile(params: {
    readonly sessionId: string;
    readonly path: string;
    readonly content: string;
  }): Promise<unknown>;
}

/**
 * Narrow ACP-client terminal handle the ACP-backed process runner needs.
 * Structurally compatible with `@agentclientprotocol/sdk`'s `TerminalHandle`.
 */
export interface IAcpTerminalHandle {
  readonly id: string;
  currentOutput(): Promise<{ readonly output: string; readonly truncated: boolean }>;
  waitForExit(): Promise<{
    readonly exitCode?: number | null;
    readonly signal?: string | null;
  }>;
  kill(): Promise<unknown>;
  release(): Promise<unknown>;
}

/**
 * Narrow ACP-client terminal surface. Implemented by `../acp-client`'s
 * `AcpClient.createTerminal`.
 */
export interface IAcpTerminalClient {
  createTerminal(params: {
    readonly sessionId: string;
    readonly command: string;
    readonly args?: string[];
    readonly env?: Array<{ readonly name: string; readonly value: string }>;
    readonly cwd?: string | null;
    readonly outputByteLimit?: number | null;
  }): Promise<IAcpTerminalHandle>;
}

/**
 * Notification that a terminal was created for a session. The ACP adapter
 * (`AcpSession`) uses it to correlate the terminal with the in-flight Bash
 * tool call and attach a `{type: 'terminal'}` content entry to the tool card.
 */
export interface AcpTerminalCreatedEvent {
  readonly sessionId: string;
  /**
   * The full shell invocation string (the `-c` payload of the exec call,
   * `cd <cwd> && <command>`), used to match the tool call whose
   * `args.command` it ends with.
   */
  readonly shellCommand: string;
  readonly terminalId: string;
}

export type AcpTerminalCreatedListener = (event: AcpTerminalCreatedEvent) => void;

export interface IAcpConnection {
  readonly _serviceBrand: undefined;
  /** Bind the process-wide ACP client connection. Later binds replace earlier ones. */
  bind(client: IAcpFsClient & IAcpTerminalClient): void;
  /** The bound ACP client connection. Throws if called before {@link bind}. */
  get(): IAcpFsClient & IAcpTerminalClient;
  /** Whether a client connection has been bound. */
  readonly bound: boolean;
  /** Bind the client's FS capabilities (from the `initialize` handshake). */
  bindFsCapabilities(fs: { readTextFile?: boolean; writeTextFile?: boolean } | undefined): void;
  /** Whether the client supports `fs.readTextFile`. */
  readonly fsReadTextFile: boolean;
  /** Whether the client supports `fs.writeTextFile`. */
  readonly fsWriteTextFile: boolean;
  /** Bind the client's terminal capability (from the `initialize` handshake). */
  bindTerminalCapability(terminal: boolean | undefined): void;
  /** Whether the client supports the `terminal/*` reverse-RPC surface. */
  readonly terminalEnabled: boolean;
  /** Notify listeners that a terminal was created (called by the ACP runner). */
  notifyTerminalCreated(event: AcpTerminalCreatedEvent): void;
  /** Subscribe to terminal-created notifications. Returns an unsubscribe. */
  onTerminalCreated(listener: AcpTerminalCreatedListener): () => void;
}

export const IAcpConnection: ServiceIdentifier<IAcpConnection> =
  createDecorator<IAcpConnection>('acpConnection');

export class AcpConnection implements IAcpConnection {
  declare readonly _serviceBrand: undefined;

  private client: (IAcpFsClient & IAcpTerminalClient) | undefined;
  private _fsReadTextFile = false;
  private _fsWriteTextFile = false;
  private _terminalEnabled = false;
  private readonly terminalCreatedListeners = new Set<AcpTerminalCreatedListener>();

  bind(client: IAcpFsClient & IAcpTerminalClient): void {
    this.client = client;
  }

  get(): IAcpFsClient & IAcpTerminalClient {
    if (this.client === undefined) {
      throw new Error(
        'IAcpConnection.get() called before bind() — acp-server must bind the ACP client connection before any session performs file or terminal IO.',
      );
    }
    return this.client;
  }

  get bound(): boolean {
    return this.client !== undefined;
  }

  bindFsCapabilities(fs: { readTextFile?: boolean; writeTextFile?: boolean } | undefined): void {
    this._fsReadTextFile = fs?.readTextFile === true;
    this._fsWriteTextFile = fs?.writeTextFile === true;
  }

  get fsReadTextFile(): boolean {
    return this._fsReadTextFile;
  }

  get fsWriteTextFile(): boolean {
    return this._fsWriteTextFile;
  }

  bindTerminalCapability(terminal: boolean | undefined): void {
    this._terminalEnabled = terminal === true;
  }

  get terminalEnabled(): boolean {
    return this._terminalEnabled;
  }

  notifyTerminalCreated(event: AcpTerminalCreatedEvent): void {
    for (const listener of this.terminalCreatedListeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not take down process execution.
      }
    }
  }

  onTerminalCreated(listener: AcpTerminalCreatedListener): () => void {
    this.terminalCreatedListeners.add(listener);
    return () => {
      this.terminalCreatedListeners.delete(listener);
    };
  }
}

registerScopedService(
  LifecycleScope.App,
  IAcpConnection,
  AcpConnection,
  ScopeActivation.OnDemand,
  'acp',
);
