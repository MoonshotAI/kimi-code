/**
 * `kimi vis` sub-command.
 *
 * CLI glue only: resolves the kimi home, starts the in-process session
 * visualizer server (auto-picking a free port by default), prints the URL,
 * optionally opens the browser (with an optional session deep-link), then
 * waits for Ctrl-C and shuts the server down. The visualizer server itself
 * lives in `@moonshot-ai/vis-server`.
 */

import type { Command } from 'commander';

import { createCliTelemetryBootstrap } from '#/cli/telemetry';
import { openUrl } from '#/utils/open-url';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface StartedVisServer {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly close: () => Promise<void>;
}

export interface StartVisServerArgs {
  readonly homeDir: string;
  readonly port: number;
  readonly host?: string;
  readonly webAsset?: { gzipped: Uint8Array };
}

export interface VisDeps {
  readonly getHomeDir: () => string;
  readonly startVisServer: (opts: StartVisServerArgs) => Promise<StartedVisServer>;
  readonly openUrl: (url: string) => Promise<void>;
  readonly waitForShutdown: () => Promise<void>;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export interface VisOptions {
  readonly open: boolean;
  readonly port?: number;
  readonly host?: string;
  readonly sessionId?: string;
}

export async function handleVis(deps: VisDeps, opts: VisOptions): Promise<void> {
  const homeDir = deps.getHomeDir();

  // Lazily load the embedded single-file SPA so normal `kimi` startup never
  // pays for it. The module is generated at build time (prebuild). When running
  // from source without a build — e.g. tests — the generated value module is
  // absent and the dynamic import throws; in that case the server falls back to
  // its own static `public/` directory.
  let webAsset: { gzipped: Uint8Array } | undefined;
  try {
    const { VIS_WEB_GZIP_B64 } = await import('#/generated/vis-web-asset');
    if (VIS_WEB_GZIP_B64.length > 0) {
      webAsset = { gzipped: new Uint8Array(Buffer.from(VIS_WEB_GZIP_B64, 'base64')) };
    }
  } catch {
    // Embedded asset not generated in this context — fall back to filesystem.
  }

  let server: StartedVisServer;
  try {
    server = await deps.startVisServer({
      homeDir,
      port: opts.port ?? 0,
      ...(opts.host === undefined ? {} : { host: opts.host }),
      ...(webAsset === undefined ? {} : { webAsset }),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    deps.stderr.write(`Failed to start kimi vis: ${msg}\n`);
    return deps.exit(1);
  }

  const target =
    opts.sessionId === undefined
      ? server.url
      : `${server.url}sessions/${encodeURIComponent(opts.sessionId)}`;

  deps.stdout.write(`kimi vis is running at ${server.url}\n`);
  deps.stdout.write('Press Ctrl-C to stop.\n');

  if (opts.open) {
    try {
      await deps.openUrl(target);
    } catch {
      deps.stderr.write(`Could not open a browser; visit ${target} manually.\n`);
    }
  }

  await deps.waitForShutdown();
  await server.close();
}

export function registerVisCommand(parent: Command, overrides?: Partial<VisDeps>): void {
  parent
    .command('vis')
    .description('Launch the session visualizer in your browser.')
    .option('--port <number>', 'Port to bind. Default: auto-pick a free port.')
    .option('--host <host>', 'Host to bind. Default: 127.0.0.1.')
    .option('--no-open', 'Do not open the browser automatically.')
    .argument('[sessionId]', 'Open directly to this session.')
    .action(
      async (
        sessionId: string | undefined,
        options: { port?: string; host?: string; open?: boolean },
      ) => {
        const port = options.port === undefined ? undefined : Number.parseInt(options.port, 10);
        await handleVis(createDefaultVisDeps(overrides), {
          open: options.open !== false,
          ...(port === undefined || Number.isNaN(port) ? {} : { port }),
          ...(options.host === undefined ? {} : { host: options.host }),
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      },
    );
}

function createDefaultVisDeps(overrides: Partial<VisDeps> = {}): VisDeps {
  return {
    getHomeDir: overrides.getHomeDir ?? (() => createCliTelemetryBootstrap().homeDir),
    startVisServer:
      overrides.startVisServer ??
      (async (opts) => {
        // Dynamic import keeps the vis server (and Hono) out of the hot path.
        const { startVisServer } = await import('@moonshot-ai/vis-server/start');
        return startVisServer(opts);
      }),
    // `openUrl` is a synchronous fire-and-forget; adapt it to the async dep.
    openUrl:
      overrides.openUrl ??
      (async (url: string) => {
        openUrl(url);
      }),
    waitForShutdown: overrides.waitForShutdown ?? waitForSigint,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
  };
}

function waitForSigint(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSig = (): void => {
      process.off('SIGINT', onSig);
      resolve();
    };
    process.on('SIGINT', onSig);
  });
}
