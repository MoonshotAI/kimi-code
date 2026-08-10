/**
 * Local export harness — G-1 消费面切换的最小实现 (`apps/kimi-code` 消除
 * 对 `@moonshot-ai/kimi-code-sdk` 的 import)。
 *
 * `kimi export` 只消费 SDK `KimiHarness` 的一小片表面,这里实现该子集:
 *   - config: `ensureConfigFile` / `getConfig` 直接读写 host 的 config.toml
 *     (复用 `#/cli/runtime-config`,与 SDK 的 host-data 模型一致);
 *   - sessions: `listSessions` / `exportSession` 走 `kimi-server-serve` 的
 *     `session/list` / `session/export` RPC(`NativeServerClient`,与
 *     native-session 同一条 stdio 通道)。engine 侧生成完整 zip(manifest +
 *     wire records + session 目录文件),宿主只负责落盘。
 *
 * 类型只覆盖本文件消费的字段(宽松形状);engine 不可用时明确降级
 * (空列表 / 抛出可读错误),不伪造数据。
 */

import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { EngineSessionRecord } from '../native-server-client';
import { NativeServerClient } from '../native-server-client';

import type { KimiHostIdentity } from '#/cli/oauth-local';
import {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
} from '#/cli/runtime-config';

/** 会话摘要 — `kimi export` 消费的 `SessionSummary` 子集。 */
export interface SessionSummary {
  readonly id: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly title?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly [key: string]: unknown;
}

/** 导出时的宿主 shell 环境 — 与 `detectShellEnvironment` 的字段一致。 */
export interface ShellEnvironment {
  readonly term?: string | undefined;
  readonly termProgram?: string | undefined;
  readonly termProgramVersion?: string | undefined;
  readonly multiplexer?: string | undefined;
  readonly shell?: string | undefined;
}

/** Telemetry 客户端 — `kimi export` 消费的 `track`/`withContext`/`setContext` 子集。 */
export interface TelemetryClient {
  track(event: string, properties?: Readonly<Record<string, unknown>>): void;
  withContext(patch: Readonly<Record<string, unknown>>): unknown;
  setContext(patch: Readonly<Record<string, unknown>>): void;
}

/** 导出清单 — 与 SDK `ExportSessionManifest` 消费字段一致。 */
export interface ExportSessionManifest {
  readonly sessionId: string;
  readonly exportedAt: string;
  readonly kimiCodeVersion: string;
  readonly wireProtocolVersion: string;
  readonly os: string;
  readonly nodejsVersion: string;
  readonly workspaceDir: string;
  readonly [key: string]: unknown;
}

/** `harness.exportSession` 的输入 — 消费字段 + 透传的宽松形状。 */
export interface ExportSessionInput {
  readonly id: string;
  readonly version?: string | undefined;
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
  readonly outputPath?: string | undefined;
  readonly includeGlobalLog?: boolean | undefined;
  readonly [key: string]: unknown;
}

/** `harness.exportSession` 的结果 — 消费面只有 `zipPath`。 */
export interface ExportSessionResult {
  readonly zipPath: string;
  readonly entries?: readonly string[] | undefined;
  readonly sessionDir?: string | undefined;
  readonly manifest?: ExportSessionManifest | undefined;
  readonly [key: string]: unknown;
}

/** 导出 harness 的 auth 面 — 只消费 `getCachedAccessToken`(telemetry 用)。 */
export interface ExportHarnessAuth {
  getCachedAccessToken(providerName?: string): Promise<string | undefined>;
}

/** 本地 `KimiHarness` — `kimi export` 消费的方法子集。 */
export interface KimiHarness {
  readonly homeDir: string;
  readonly auth: ExportHarnessAuth;
  track(event: string, properties?: Readonly<Record<string, unknown>>): void;
  ensureConfigFile(): Promise<void>;
  getConfig(): Promise<{ readonly defaultModel?: string; readonly telemetry?: boolean }>;
  listSessions(options?: { readonly workDir?: string }): Promise<readonly SessionSummary[]>;
  exportSession(input: ExportSessionInput): Promise<ExportSessionResult>;
  /** 释放引擎 RPC 客户端(幂等;进程即将退出时可不调)。 */
  close(): Promise<void>;
}

export interface CreateKimiHarnessOptions {
  readonly homeDir?: string | undefined;
  readonly identity?: KimiHostIdentity | undefined;
  readonly telemetry?: TelemetryClient | undefined;
}

/** 与 SDK 默认 config.toml 相同的占位文本(首次创建时写入)。 */
const DEFAULT_CONFIG_FILE_TEXT = `# ~/.kimi-code/config.toml
# Runtime settings for Kimi Code.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
`;

/**
 * Build the local export harness. `ensureConfigFile` / `getConfig` read and
 * write the host config.toml; `listSessions` / `exportSession` talk to the
 * Rust engine over the rust-loop bridge (engine unavailable → empty list /
 * readable error).
 */
export function createKimiHarness(options: CreateKimiHarnessOptions = {}): KimiHarness {
  const homeDir = resolveKimiHome(options.homeDir);
  const configPath = resolveConfigPath({ homeDir });
  const telemetry = options.telemetry;
  let client: NativeServerClient | undefined;

  /** Lazy stdio RPC client — the engine may be absent (TS fallback path). */
  const getClient = (): NativeServerClient => {
    client ??= new NativeServerClient();
    return client;
  };

  const listSessions = async (
    input: { readonly workDir?: string } = {},
  ): Promise<SessionSummary[]> => {
    let records: EngineSessionRecord[];
    try {
      const result = (await getClient().call('session/list', { limit: 50, offset: 0 })) as {
        sessions: EngineSessionRecord[];
      } | null;
      records = result?.sessions ?? [];
    } catch {
      // Engine unavailable → empty list (degrade, never fake data).
      records = [];
    }
    const normalizedWorkDir = input.workDir === undefined ? undefined : resolve(input.workDir);
    return records
      .filter(
        (record) =>
          normalizedWorkDir === undefined ||
          (record.work_dir !== undefined && resolve(record.work_dir) === normalizedWorkDir),
      )
      .map(toSessionSummary)
      .toSorted((a, b) => b.updatedAt - a.updatedAt);
  };

  const exportSession = async (input: ExportSessionInput): Promise<ExportSessionResult> => {
    const sessions = await listSessions();
    const summary = sessions.find((item) => item.id === input.id);
    if (summary === undefined) {
      throw new Error(`Session not found: ${input.id}`);
    }
    // The engine assembles the full archive (manifest + wire records + session
    // directory files); the host only persists the returned zip.
    let exported: { zip_base64?: string } | null;
    try {
      exported = (await getClient().call('session/export', {
        session_id: input.id,
        homedir: summary.sessionDir,
      })) as { zip_base64?: string } | null;
    } catch (error) {
      throw new Error(
        `Session export failed: ${input.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error },
      );
    }
    if (exported === null || typeof exported.zip_base64 !== 'string') {
      throw new Error(`Session export failed: ${input.id}`);
    }
    const zipPath = resolve(input.outputPath ?? defaultExportZipName(input.id));
    await mkdir(dirname(zipPath), { recursive: true });
    await writeFile(zipPath, Buffer.from(exported.zip_base64, 'base64'));
    return { zipPath, sessionDir: summary.sessionDir };
  };

  return {
    homeDir,
    auth: {
      async getCachedAccessToken(providerName) {
        // Static-key providers resolve from the host config.toml. The OAuth
        // token flow is out of this minimal surface — a missing telemetry
        // access token only omits an outbound header.
        if (providerName === undefined) return;
        const { config } = loadRuntimeConfigSafe(configPath);
        const provider = config['providers']?.[providerName];
        if (typeof provider !== 'object' || provider === null) return;
        const apiKey = provider['apiKey'];
        return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : undefined;
      },
    },
    track(event, properties) {
      telemetry?.track(event, properties);
    },
    async ensureConfigFile() {
      await ensureLocalConfigFile(configPath);
    },
    async getConfig() {
      const { config } = loadRuntimeConfigSafe(configPath);
      return {
        defaultModel: config.defaultModel,
        telemetry: config.telemetry,
      };
    },
    listSessions,
    exportSession,
    async close() {
      client?.close();
      client = undefined;
    },
  };
}

function toSessionSummary(record: EngineSessionRecord): SessionSummary {
  const now = Date.now();
  return {
    id: record.id,
    title: record.title,
    workDir: record.work_dir ?? '',
    sessionDir: record.work_dir ?? '',
    createdAt: parseEngineTime(record.created_at, now),
    updatedAt: parseEngineTime(record.updated_at, now),
    ...(isRecord(record.metadata) ? { metadata: record.metadata } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEngineTime(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? fallback : ms;
}

/** 默认 zip 名:`kimi-debug-<shortId>-<timestamp>.zip`(与 SDK 一致)。 */
function defaultExportZipName(sessionId: string): string {
  const shortId = sessionId.slice(0, 8);
  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  return `kimi-debug-${shortId}-${timestamp}.zip`;
}

/** Create `<configPath>` with the default placeholder text when absent. */
async function ensureLocalConfigFile(configPath: string): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(configPath, 'wx', 0o600);
    await handle.writeFile(DEFAULT_CONFIG_FILE_TEXT, 'utf-8');
  } catch (error) {
    if (isFileExistsError(error)) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}
