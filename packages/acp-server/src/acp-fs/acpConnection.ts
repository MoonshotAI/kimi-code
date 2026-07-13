/**
 * ACP client-fs bridge — App-scope holder for the process-wide ACP client
 * connection used by the ACP-backed `IHostFileSystem` to reverse-RPC file text
 * reads/writes to the editor (ACP `fs.readTextFile` / `fs.writeTextFile`).
 *
 * One ACP client connection exists per `acp-server` process (a single stdio
 * `AgentSideConnection`, multiplexed by `sessionId`); it is established after
 * `bootstrap()`, so it is bound here lazily via {@link IAcpConnection.bind}
 * rather than seeded at composition time. The ACP-backed `IHostFileSystem`
 * (Session scope) reads it on first use through {@link IAcpConnection.get}.
 */

import {
  createDecorator,
  InstantiationType,
  LifecycleScope,
  registerScopedService,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';

/**
 * Narrow ACP-client file surface the ACP-backed `IHostFileSystem` needs.
 *
 * Structurally compatible with `@agentclientprotocol/sdk`'s
 * `AgentSideConnection` (`readTextFile` / `writeTextFile`), so the host can
 * `bind(conn)` directly without an adapter.
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

export interface IAcpConnection {
  readonly _serviceBrand: undefined;
  /** Bind the process-wide ACP client connection. Later binds replace earlier ones. */
  bind(client: IAcpFsClient): void;
  /** The bound ACP client connection. Throws if called before {@link bind}. */
  get(): IAcpFsClient;
  /** Whether a client connection has been bound. */
  readonly bound: boolean;
  /** Bind the client's FS capabilities (from the `initialize` handshake). */
  bindFsCapabilities(fs: { readTextFile?: boolean; writeTextFile?: boolean } | undefined): void;
  /** Whether the client supports `fs.readTextFile`. */
  readonly fsReadTextFile: boolean;
  /** Whether the client supports `fs.writeTextFile`. */
  readonly fsWriteTextFile: boolean;
}

export const IAcpConnection: ServiceIdentifier<IAcpConnection> =
  createDecorator<IAcpConnection>('acpConnection');

export class AcpConnection implements IAcpConnection {
  declare readonly _serviceBrand: undefined;

  private client: IAcpFsClient | undefined;
  private _fsReadTextFile = false;
  private _fsWriteTextFile = false;

  bind(client: IAcpFsClient): void {
    this.client = client;
  }

  get(): IAcpFsClient {
    if (this.client === undefined) {
      throw new Error(
        'IAcpConnection.get() called before bind() — acp-server must bind the ACP client connection before any session performs file IO.',
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
}

registerScopedService(
  LifecycleScope.App,
  IAcpConnection,
  AcpConnection,
  InstantiationType.Delayed,
  'acp',
);
