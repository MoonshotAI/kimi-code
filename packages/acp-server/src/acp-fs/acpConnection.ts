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
}

export const IAcpConnection: ServiceIdentifier<IAcpConnection> =
  createDecorator<IAcpConnection>('acpConnection');

export class AcpConnection implements IAcpConnection {
  declare readonly _serviceBrand: undefined;

  private client: IAcpFsClient | undefined;

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
}

registerScopedService(
  LifecycleScope.App,
  IAcpConnection,
  AcpConnection,
  InstantiationType.Delayed,
  'acp',
);
