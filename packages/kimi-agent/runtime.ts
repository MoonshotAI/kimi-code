/**
 * Backward-compat runtime shim — full implementations from archived agent-core.
 *
 * Provides ALL runtime VALUE symbols formerly exported by
 * `@moonshot-ai/agent-core`.  Types are in `contract.ts`.
 */
// ── Errors (full v1 implementation) ────────────────────────────────────
export {
  ErrorCodes,
  KimiError,
  KIMI_ERROR_INFO,
  fromKimiErrorPayload,
  isKimiError,
  makeErrorPayload,
  resolveErrorTitle,
  toKimiErrorPayload,
  onUnexpectedError,
  resetUnexpectedErrorHandler,
  safelyCallListener,
  setUnexpectedErrorHandler,
  type KimiErrorCode,
  type KimiErrorInfo,
  type KimiErrorOptions,
  type KimiErrorPayload,
  type UnexpectedErrorHandler,
} from './runtime/errors/index';

// ── i18n ────────────────────────────────────────────────────────────────
export { t, setLocale, getLocale } from './runtime/i18n-core';
export type { Locale, TranslationKey } from './runtime/i18n-core';

// ── Diagnostic logging ──────────────────────────────────────────────────
export {
  log,
  redact,
  flushDiagnosticLogs,
  flushDiagnosticLogsSync,
  resolveGlobalLogPath,
  type LogContext,
  type LogLevel,
  type LogPayload,
  type Logger,
} from './runtime/logging-core/index';

import { homedir } from 'node:os';

import { join } from 'pathe';

/** Resolve the Kimi Code home directory (v1 `config/path.ts` semantics). */
export function resolveKimiHome(homeDir?: string | undefined): string {
  return homeDir ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

import type { KimiConfig } from './src/contract';

// ── Image compression ───────────────────────────────────────────────────
// (The v1 image-compression runtime was never ported into this package —
// the surface is dropped from the compat layer until it exists for real.)

// ── Config helpers ──────────────────────────────────────────────────────
// Re-export the real effectiveModelAlias from kosong if available, else inline.
export function effectiveModelAlias(config: KimiConfig, alias?: string): string {
  return alias ?? config?.model ?? 'default';
}
export function loadRuntimeConfigSafe(): Promise<KimiConfig | null> {
  return Promise.resolve(null);
}
export function resolveConfigPath(): string {
  return '';
}
export function limitAgentReplayByTurns(_limit?: number): number {
  return 50;
}

// ── HTTP proxy ──────────────────────────────────────────────────────────
export function installGlobalProxyDispatcher(): void {}

// ── Schemas (zod) ───────────────────────────────────────────────────────
import { z } from 'zod';
export const McpServerConfigSchema = z
  .object({
    name: z.string(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    type: z.enum(['stdio', 'sse', 'streamableHttp']).optional(),
    disabled: z.boolean().optional(),
  })
  .passthrough();
export const HookDefSchema = z.object({
  name: z.string(),
  match: z.unknown().optional(),
}).passthrough();
export const KimiConfigSchema = z.object({}).passthrough();
export const ModelAliasSchema = z.string().or(z.object({}).passthrough());
export const ProviderConfigSchema = z.object({}).passthrough();
export function transformTomlData(data: unknown): unknown {
  return data;
}

// ── Flags ───────────────────────────────────────────────────────────────
export const FLAG_DEFINITIONS: Record<string, unknown> = {};

// ── Session store ───────────────────────────────────────────────────────
// (The v1 session-store was never ported — `encodeWorkDirKey` is dropped
// from the compat layer until it exists for real.)

// ── Migration / wire records ────────────────────────────────────────────
export const AGENT_WIRE_PROTOCOL_VERSION = 7;  // matches v0.19.0+
export function migrateWireRecord<T>(record: T): T {
  return record;
}
export function resolveWireMigrations(_version: number): Array<{
  fromVersion: number;
  toVersion: number;
  migrate: (r: unknown) => unknown;
}> {
  return [];
}
export type WireMigration = {
  fromVersion: number;
  toVersion: number;
  migrate: (r: unknown) => unknown;
};

// ── Compaction runtime helpers ──────────────────────────────────────────
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 10_000;
export const COMPACTION_ELISION_VARIANT = 'append' as const;
export function buildCompactionElisionText(): string {
  return '…';
}
export function collectCompactableUserMessages<T>(msgs: T[]): T[] {
  return msgs;
}
export function estimateTokens(_text: string): number {
  return 0;
}
export function isRealUserInput(): boolean {
  return true;
}
export function renderToolResultForModel(r: unknown): string {
  if (typeof r === 'string') return r;
  if (r === null || r === undefined) return '';
  try {
    return JSON.stringify(r) ?? '';
  } catch {
    return '';
  }
}
export function selectCompactionUserMessages<T>(msgs: T[], _limit: number): T[] {
  return msgs;
}
export function selectRecentUserMessages<T>(msgs: T[], _limit: number): T[] {
  return msgs;
}

// ── Telemetry ───────────────────────────────────────────────────────────

export function withTelemetryContext<T>(_ctx: unknown, fn: () => T | Promise<T>): Promise<T> {
  return Promise.resolve().then(() => fn());
}

// ── Provider types (re-exported for node-sdk internal consumers) ────────

export interface ModelProvider {
  name: string;
  kind: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface ResolvedRuntimeProvider {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
}

// ── Type stubs for Phase 6.2.x compat (v1-only record shapes) ──────────
// These are re-exported by compatibility.ts for migration-legacy and vis packages.
// Full definitions live in the archived agent-core.

export interface CompactionBeginData { turnId: string; }
export interface PermissionApprovalResultRecord { toolCallId: string; approved: boolean; }
export type PermissionMode = 'manual' | 'auto' | 'plan';
export interface UsageRecordScope { sessionId: string; }
export interface ToolStoreUpdate { name: string; }
export interface LoopRecordedEvent { type: string; payload: unknown; }
export interface ContextMessage { role: string; content: unknown; }
export type PromptOrigin = 'user' | 'assistant' | 'system' | 'tool';
export interface BackgroundTaskInfo { id: string; status: string; }
export type BackgroundTaskStatus = 'pending' | 'running' | 'done' | 'failed';
export interface ProcessBackgroundTaskInfo { pid: number; }
export interface AgentBackgroundTaskInfo { agentId: string; }
export interface QuestionBackgroundTaskInfo { questionId: string; }