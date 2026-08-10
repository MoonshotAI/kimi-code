/**
 * Local stand-ins for the `@moonshot-ai/kimi-code-sdk` symbols consumed by
 * `src/main.ts` (G-1 CLI consumption cutover). Only the surfaces the process
 * entrypoint uses are ported; the rest stays on the SDK until the TS host
 * retires. Diagnostic logging is best-effort and must never affect startup.
 */

import { mkdirSync } from 'node:fs';
import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { KimiHostIdentity } from '#/cli/oauth-local';
import type { PromptHarness } from '#/cli/prompt-session';
import {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
} from '#/cli/runtime-config';

/* ------------------------------------------------------------------ */
/* Telemetry contract (SDK `TelemetryClient` shape)                    */
/* ------------------------------------------------------------------ */

export type TelemetryPropertyValue = boolean | number | string | null | undefined;

export type TelemetryProperties = Readonly<Record<string, TelemetryPropertyValue>>;

export interface TelemetryContextPatch {
  readonly sessionId?: string | null;
}

export interface TelemetryClient {
  track(event: string, properties?: TelemetryProperties): void;
  withContext?(patch: TelemetryContextPatch): TelemetryClient;
  setContext?(patch: TelemetryContextPatch): void;
}

/* ------------------------------------------------------------------ */
/* Diagnostic log (SDK `log` / `flushDiagnosticLogs` / path)           */
/* ------------------------------------------------------------------ */

/** Resolve the global diagnostic log path (v1 `logging` semantics). */
export function resolveGlobalLogPath(homeDir: string): string {
  return join(homeDir, 'logs', 'kimi-code.log');
}

interface DiagnosticLogEntry {
  readonly ts: string;
  readonly level: string;
  readonly message: string;
  readonly payload?: unknown;
}

let pendingWrite: Promise<void> = Promise.resolve();

function enqueueLog(level: string, message: string, payload?: unknown): void {
  const entry: DiagnosticLogEntry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(payload === undefined ? {} : { payload: normalizeLogPayload(payload) }),
  };
  pendingWrite = pendingWrite.then(() => appendLogLine(entry)).catch(() => {});
}

/**
 * Shared diagnostic logger singleton (mirrors the SDK root logger role).
 * Writes JSON lines to `<home>/logs/kimi-code.log`; write failures are
 * swallowed so logging never affects startup or the upgrade command.
 */
export const log: {
  readonly debug: (message: string, payload?: unknown) => void;
  readonly info: (message: string, payload?: unknown) => void;
  readonly warn: (message: string, payload?: unknown) => void;
  readonly error: (message: string, payload?: unknown) => void;
} = {
  debug(message, payload) {
    enqueueLog('debug', message, payload);
  },
  info(message, payload) {
    enqueueLog('info', message, payload);
  },
  warn(message, payload) {
    enqueueLog('warn', message, payload);
  },
  error(message, payload) {
    enqueueLog('error', message, payload);
  },
};

/** Flush queued diagnostic entries to disk (awaited before process exit). */
export async function flushDiagnosticLogs(): Promise<void> {
  await pendingWrite;
}

async function appendLogLine(entry: DiagnosticLogEntry): Promise<void> {
  const logPath = resolveGlobalLogPath(resolveKimiHome());
  mkdirSync(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

/** Keep `Error` payloads readable in the log (JSON would otherwise drop them). */
function normalizeLogPayload(payload: unknown): unknown {
  if (payload instanceof Error) {
    return { name: payload.name, message: payload.message, stack: payload.stack };
  }
  if (Array.isArray(payload)) return payload.map(normalizeLogPayload);
  if (isPlainRecord(payload)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      out[key] = normalizeLogPayload(value);
    }
    return out;
  }
  return payload;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Upgrade harness (SDK `createKimiHarness` subset)                    */
/* ------------------------------------------------------------------ */

export interface KimiHarnessOptions {
  readonly homeDir: string;
  readonly identity?: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
}

const DEFAULT_CONFIG_SCAFFOLD = `# ~/.kimi-code/config.toml
# Runtime settings for Kimi Code.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
`;

/**
 * Minimal harness for the `kimi upgrade` flow: `ensureConfigFile` /
 * `getConfig` / `close` plus the telemetry surface `initializeCliTelemetry`
 * reads (`homeDir` / `auth` / `track`). Nothing else on `PromptHarness` is
 * reachable from the upgrade path, so the rest is stubbed via a single cast
 * at this boundary. `auth.getCachedAccessToken` returns `null`: the telemetry
 * transport treats a missing token as anonymous, and no local token reader
 * exists on the TS host side yet.
 */
export function createKimiHarness(options: KimiHarnessOptions): PromptHarness {
  const homeDir = options.homeDir;
  const configPath = resolveConfigPath({ homeDir });
  const harness = {
    homeDir,
    auth: {
      getCachedAccessToken: (): Promise<string | null> => Promise.resolve(null),
    },
    track: (event: string, properties?: TelemetryProperties): void => {
      options.telemetry.track(event, properties);
    },
    ensureConfigFile: async (): Promise<void> => {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(configPath, 'wx', 0o600);
        await handle.writeFile(DEFAULT_CONFIG_SCAFFOLD, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
        throw error;
      } finally {
        await handle?.close();
      }
    },
    getConfig: () => {
      const { config } = loadRuntimeConfigSafe(configPath);
      return config;
    },
    close: async (): Promise<void> => {
      await flushDiagnosticLogs();
    },
  } as unknown as PromptHarness;
  return harness;
}
