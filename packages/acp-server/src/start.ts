/**
 * acp-server bootstrap — wires `@moonshot-ai/agent-core-v2` (the DI × Scope
 * engine) into an ACP (Agent Client Protocol) stdio server.
 *
 * Composition root: `bootstrap()` builds the App `Scope`; a `@moonshot-ai/
 * klient` facade over the in-memory transport is created on top of it, and
 * every ACP method handler drives the engine through that facade. The
 * ACP-backed `IHostFileSystem` (./acp-fs) is imported for its Session-scope
 * registration side effect (see the import below) — being registered on the
 * same scope the memory transport dispatches against, it keeps working
 * unchanged.
 */

import { Readable, Writable } from 'node:stream';

import { AgentSideConnection, ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import {
  bootstrap,
  IAppendLogStore,
  logSeed,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type Scope,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import type { Klient } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/memory';

// Importing the `acp-fs` barrel also registers the ACP-backed Session-scope
// `IHostFileSystem` and the App-scope `IAcpConnection` holder via the barrel's
// module side effects. `IAcpConnection` is used below to bind the ACP client
// connection.
import { IAcpConnection } from './acp-fs';
import { AcpServer, type AcpServerOptions } from './server';

export interface RunAcpServerOptions extends AcpServerOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /**
   * Extra App-scope service seeds forwarded to `bootstrap()`. Intended for
   * tests — e.g. seeding a scripted `IProtocolAdapterRegistry` to drive a
   * deterministic turn without a real LLM. Seeds shadow any registered
   * binding with the same service identifier.
   */
  readonly extraSeeds?: ScopeSeed;
}

export interface RunningAcpServer {
  readonly core: Scope;
  readonly klient: Klient;
  readonly conn: AgentSideConnection;
  close(): Promise<void>;
}

/**
 * Redirect `console.*` to stderr. Stdout is the ACP JSON-RPC channel; any stray
 * write from a dependency would corrupt the protocol stream.
 */
function redirectConsoleToStderr(): void {
  const sink = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };
  globalThis.console.log = sink;
  globalThis.console.info = sink;
  globalThis.console.warn = sink;
  globalThis.console.debug = sink;
}

/**
 * Drive an {@link AcpServer} over an arbitrary ACP {@link Stream}.
 *
 * Boots `agent-core-v2`, creates the in-memory `Klient` facade over the app
 * scope, binds the ACP client connection into {@link IAcpConnection} (so the
 * `acp` `IHostFileSystem` can reverse-RPC file IO), and resolves when the
 * connection closes.
 */
export async function runAcpServerWithStream(
  stream: Stream,
  opts: RunAcpServerOptions = {},
): Promise<RunningAcpServer> {
  const homeDir = resolveKimiHome(opts.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });
  // `ILogOptions` (logSeed) is required by the Session-scoped log writer; any
  // session creation would otherwise fail to instantiate the Session scope.
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  // `bootstrap()` seeds `IFileSystemStorageService` with a `FileStorageService`
  // rooted at `homeDir`, so session metadata, wire records, blobs, and the
  // session index all persist to disk.
  const { app: core } = bootstrap({ homeDir, configPath }, [
    ...logSeed(logging),
    ...(opts.extraSeeds ?? []),
  ]);

  // The klient dispatches against the same app scope — calls and events stay
  // in-process but observe wire-shaped (JSON-cloned) data. The klient does
  // NOT own the scope: lifecycle stays with this composition root.
  const klient = createKlient({ scope: core });
  const acpConnection = core.accessor.get(IAcpConnection);

  const conn = new AgentSideConnection((c) => {
    // Bind the process-wide ACP client connection before any session performs
    // file IO. The `acp` `IHostFileSystem` reads it lazily via
    // `IAcpConnection.get()`.
    acpConnection.bind(c);
    return new AcpServer(c, klient, acpConnection, {
      agentInfo: opts.agentInfo,
      disableAuth: opts.disableAuth,
      terminalAuthEnv: opts.terminalAuthEnv,
      terminalAuthLegacyCommand: opts.terminalAuthLegacyCommand,
    });
  }, stream);

  const close = async (): Promise<void> => {
    // Detach the klient's event subscriptions first so disposal below cannot
    // deliver into a torn-down scope.
    await klient.close();
    // Flush the append-log write-behind before disposing, so a clean shutdown
    // never races a pending drain against teardown (and doesn't drop the last
    // persisted ops). Best-effort: a flush failure must not block disposal.
    try {
      await core.accessor.get(IAppendLogStore).flush();
    } catch {
      // ignore — disposal proceeds regardless
    }
    core.dispose();
  };

  void conn.closed.then(() => {
    void close();
  });

  return { core, klient, conn, close };
}

/**
 * Drive an {@link AcpServer} over Node stdio (or the supplied streams).
 *
 * The ACP SDK speaks Web `ReadableStream` / `WritableStream`, so Node stdio is
 * bridged through `Readable.toWeb` / `Writable.toWeb`.
 */
export async function runAcpServer(opts: RunAcpServerOptions = {}): Promise<void> {
  redirectConsoleToStderr();
  const input = (opts.input ?? process.stdin) as Readable;
  const output = (opts.output ?? process.stdout) as Writable;
  const stream = ndJsonStream(Writable.toWeb(output), Readable.toWeb(input));
  const server = await runAcpServerWithStream(stream, opts);
  await server.conn.closed;
  await server.close();
}
