import {
  createDecorator,
  LifecycleScope,
  registerScopedService,
  ScopeActivation,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';

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

export interface AcpTerminalCreatedEvent {
  readonly sessionId: string;
  readonly shellCommand: string;
  readonly terminalId: string;
}

export type AcpTerminalCreatedListener = (event: AcpTerminalCreatedEvent) => void;

export interface IAcpConnection {
  readonly _serviceBrand: undefined;
  bind(client: IAcpFsClient & IAcpTerminalClient): void;
  get(): IAcpFsClient & IAcpTerminalClient;
  readonly bound: boolean;
  bindFsCapabilities(fs: { readTextFile?: boolean; writeTextFile?: boolean } | undefined): void;
  readonly fsReadTextFile: boolean;
  readonly fsWriteTextFile: boolean;
  bindTerminalCapability(terminal: boolean | undefined): void;
  readonly terminalEnabled: boolean;
  notifyTerminalCreated(event: AcpTerminalCreatedEvent): void;
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
