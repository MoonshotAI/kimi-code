import { Readable, Writable } from 'node:stream';

import { ndJsonStream, type AgentConnection, type Stream } from '@agentclientprotocol/sdk';
import {
  assertKimiHostIdentity,
  createKimiDefaultHeaders,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-oauth';
import {
  bootstrap,
  drainLogCloses,
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  drainSessionMetadataWrites,
  getLiveSessionById,
  ISessionContext,
  IAppendLogStore,
  ISessionIndexMirror,
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
import { IAcpConnection } from './acp-fs';
import './acp-terminal';
import { AcpServer, type AcpServerOptions, createAcpAgentApp } from './server';

export const ACP_LLM_TIMEOUT_ENV = 'KIMI_CODE_ACP_LLM_TIMEOUT_MS';

export interface RunAcpServerOptions extends AcpServerOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly hostIdentity?: KimiHostIdentity;
  readonly requestHeaders?: Record<string, string>;
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

function redirectConsoleToStderr(): void {
  const sink = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };
  globalThis.console.log = sink;
  globalThis.console.info = sink;
  globalThis.console.warn = sink;
  globalThis.console.debug = sink;
}

export async function runAcpServerWithStream(
  stream: Stream,
  opts: RunAcpServerOptions = {},
): Promise<RunningAcpServer> {
  const previousTimeout = process.env['KIMI_CODE_LLM_HEADERS_TIMEOUT_MS'];
  let didOverrideTimeout = false;
  const acpTimeout = process.env[ACP_LLM_TIMEOUT_ENV];
  if (acpTimeout !== undefined && acpTimeout.trim() !== '') {
    process.env['KIMI_CODE_LLM_HEADERS_TIMEOUT_MS'] = acpTimeout;
    didOverrideTimeout = true;
  }
  const homeDir = resolveKimiHome(opts.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  // `bootstrap()` seeds `IFileSystemStorageService` with a `FileStorageService`
  // rooted at `homeDir`, so session metadata, wire records, blobs, and the
  // session index all persist to disk. Host identity headers (User-Agent,
  // X-Msh-*) are forwarded to outbound provider requests so managed vendors
  // (e.g. api.kimi.ai) recognize the client and honor normal connection timeouts.
  const identity: KimiHostIdentity = opts.hostIdentity
    ? assertKimiHostIdentity(opts.hostIdentity)
    : {
        productName: opts.agentInfo?.name ?? 'kimi-code-acp',
        version: opts.agentInfo?.version ?? '0.0.0',
        platform: 'kimi_code_cli',
      };
  const requestHeaders =
    opts.requestHeaders ?? createKimiDefaultHeaders({ homeDir, ...identity });
  const { app: core } = bootstrap(
    {
      homeDir,
      configPath,
      clientIdentity: identity,
      args: {
        requestHeaders,
      },
    },
    [...logSeed(logging), ...(opts.extraSeeds ?? [])],
  );

  const klient = createKlient({ scope: core });
  const acpConnection = core.accessor.get(IAcpConnection);

  let resolveServer!: (server: AcpServer) => void;

  const serverReady = new Promise<AcpServer>((resolve) => {
    resolveServer = resolve;
  });
  void serverReady.catch(() => {});
  const app = createAcpAgentApp(() => serverReady);
  const conn = app.connect(stream);
  const client = acpClientFromContext(conn.client);
  acpConnection.bind(client);
  const server = new AcpServer(client, klient, acpConnection, {
    agentInfo: opts.agentInfo,
    disableAuth: opts.disableAuth,
    terminalAuthEnv: opts.terminalAuthEnv,
    terminalAuthLegacyCommand: opts.terminalAuthLegacyCommand,
    slashCommands: opts.slashCommands,
    resolveOriginalsDir: (sessionId) => {
      const handle = getLiveSessionById(core.accessor, sessionId);
      return handle === undefined
        ? undefined
        : sessionMediaOriginalsDir(handle.accessor.get(ISessionContext).sessionDir);
    },
  });
  resolveServer(server);

  let closePromise: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      await klient.close();
      const appendLogStore = core.accessor.get(IAppendLogStore);
      try {
        await appendLogStore.flush();
      } catch {}
      await drainSessionMetadataWrites();
      await core.accessor.get(ISessionIndexMirror).drain();
      core.dispose();
      await appendLogStore.drainRetirements();
      await drainSessionIndexMirror();
      await drainQueryStoreDisposals();
      await drainSessionMetadataWrites();
      await drainLogCloses();
      if (didOverrideTimeout) {
        if (previousTimeout === undefined) {
          delete process.env['KIMI_CODE_LLM_HEADERS_TIMEOUT_MS'];
        } else {
          process.env['KIMI_CODE_LLM_HEADERS_TIMEOUT_MS'] = previousTimeout;
        }
      }
    })();
    return closePromise;
  };

  void conn.closed.then(() => {
    void close();
  });

  return { core, klient, conn, close };
}

export async function runAcpServer(opts: RunAcpServerOptions = {}): Promise<void> {
  redirectConsoleToStderr();
  const input = (opts.input ?? process.stdin) as Readable;
  const output = (opts.output ?? process.stdout) as Writable;
  const stream = ndJsonStream(Writable.toWeb(output), Readable.toWeb(input));
  const server = await runAcpServerWithStream(stream, opts);
  await server.conn.closed;
  await server.close();
}
