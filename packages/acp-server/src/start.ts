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

import { ndJsonStream, type AgentConnection, type Stream } from '@agentclientprotocol/sdk';
import {
  bootstrap,
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  drainSessionMetadataWrites,
  ensureMainAgent,
  getLiveSessionById,
  IAgentRuntimeBindingService,
  IAppendLogStore,
  IHostEnvironment,
  ISessionContext,
  ISessionIndexMirror,
  IWorkspaceInstanceManager,
  logSeed,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type Scope,
  type ScopeSeed,
  sessionMediaOriginalsDir,
} from '@moonshot-ai/agent-core-v2';
import type { Klient } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/memory';

import { acpClientFromContext } from './acp-client';
// Importing the `acp-fs` barrel also registers the ACP-backed Session-scope
// `IHostFileSystem` and the App-scope `IAcpConnection` holder via the barrel's
// module side effects. `IAcpConnection` is used below to bind the ACP client
// connection.
import { IAcpConnection } from './acp-fs';
import { AcpRuntimeProviderFactory } from './acp-terminal';
import { AcpServer, type AcpServerOptions, createAcpAgentApp } from './server';

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
  readonly conn: AgentConnection;
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
  // session index all persist to disk. `clientIdentity` is required by the
  // engine: reuse the advertised ACP `agentInfo` (the embedding CLI's
  // name/version) with the CLI platform — the literal matches
  // `KIMI_CODE_PLATFORM` from `@moonshot-ai/kimi-code-oauth`, which this
  // package does not depend on.
  const { app: core } = bootstrap(
    {
      homeDir,
      configPath,
      clientIdentity: {
        productName: opts.agentInfo?.name ?? 'kimi-code-acp',
        version: opts.agentInfo?.version ?? '0.0.0',
        platform: 'kimi_code_cli',
      },
    },
    [...logSeed(logging), ...(opts.extraSeeds ?? [])],
  );

  // The klient dispatches against the same app scope — calls and events stay
  // in-process but observe wire-shaped (JSON-cloned) data. The klient does
  // NOT own the scope: lifecycle stays with this composition root.
  const klient = createKlient({ scope: core });
  const acpConnection = core.accessor.get(IAcpConnection);

  // Route every inbound ACP method to the `AcpServer`. The app must be
  // connected before the outbound client surface (`conn.client`) — and thus
  // the server — exists, so handlers dereference `server` lazily. No inbound
  // message can be dispatched before this synchronous block yields (the
  // connection's reader only runs on later microtasks), so `server` is always
  // assigned by the time a handler fires.
  let server: AcpServer;
  const app = createAcpAgentApp(() => server);
  const conn = app.connect(stream);
  const client = acpClientFromContext(conn.client);
  // Bind the process-wide ACP client connection before any session performs
  // file IO. The `acp` `IHostFileSystem` reads it lazily via
  // `IAcpConnection.get()`.
  acpConnection.bind(client);
  const workspaceManager = core.accessor.get(IWorkspaceInstanceManager);
  const acpRuntimeProvider = new AcpRuntimeProviderFactory(acpConnection, core.accessor.get(IHostEnvironment));
  const acpProviderRegistration = await workspaceManager.addProvider(acpRuntimeProvider);
  const sessionWorkspaces = new Map<string, string>();
  server = new AcpServer(client, klient, acpConnection, {
    agentInfo: opts.agentInfo,
    disableAuth: opts.disableAuth,
    terminalAuthEnv: opts.terminalAuthEnv,
    terminalAuthLegacyCommand: opts.terminalAuthLegacyCommand,
    slashCommands: opts.slashCommands,
    bindSessionRuntime: async (sessionId) => {
      const handle = getLiveSessionById(core.accessor, sessionId);
      if (handle === undefined) throw new Error(`session ${sessionId} is not live`);
      const context = handle.accessor.get(ISessionContext);
      const runtimeId = acpRuntimeProvider.bindSession(context.workspaceId, sessionId, context.cwd);
      sessionWorkspaces.set(sessionId, context.workspaceId);
      const agent = await ensureMainAgent(handle, { runtimeId });
      agent.accessor.get(IAgentRuntimeBindingService).switch(runtimeId);
    },
    unbindSessionRuntime: async (sessionId) => {
      const workspaceId = sessionWorkspaces.get(sessionId);
      if (workspaceId === undefined) return;
      sessionWorkspaces.delete(sessionId);
      await acpRuntimeProvider.unbindSession(workspaceId, sessionId);
    },
    // Prompt-image compression persists originals into the session's own
    // media-originals dir (same resolution as kap-server's prompt route):
    // live session scope → `ISessionContext.sessionDir`. A session that is
    // not live in this process yields undefined → temp-dir fallback.
    resolveOriginalsDir: (sessionId) => {
      const handle = getLiveSessionById(core.accessor, sessionId);
      return handle === undefined
        ? undefined
        : sessionMediaOriginalsDir(handle.accessor.get(ISessionContext).sessionDir);
    },
  });

  let closePromise: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
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
      // Same shutdown order as kap-server: settle queued session-metadata
      // writes, then drain the session-index mirror while the query store is
      // still open, so a queued summary lands in the read model.
      await drainSessionMetadataWrites();
      await core.accessor.get(ISessionIndexMirror).drain();
      await acpProviderRegistration.dispose();
      core.dispose();
      // `core.dispose()` runs the mirror's and the query store's synchronous
      // `dispose()`, whose drains/closes are asynchronous — await them so an
      // embedding host that removes homeDir right after close() never races
      // an in-flight shard close (ENOTEMPTY on teardown).
      await drainSessionIndexMirror();
      await drainQueryStoreDisposals();
      await drainSessionMetadataWrites();
    })();
    return closePromise;
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
