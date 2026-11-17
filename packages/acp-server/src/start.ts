import { Readable, Writable } from 'node:stream';

import { ndJsonStream, type AgentConnection, type Stream } from '@agentclientprotocol/sdk';
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

export interface RunAcpServerOptions extends AcpServerOptions {
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
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
  const homeDir = resolveKimiHome(opts.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
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
