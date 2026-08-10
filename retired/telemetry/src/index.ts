/**
 * @deprecated FROZEN — TS 迁移冻结（2026-08-10）。
 * 允许：关键 bug 修复（崩溃/数据丢失/安全/日志污染）与测试基线适配。
 * 禁止：新增功能、引擎逻辑、行为修补。新能力一律写 Rust（kimi-sdk / kimi-agent / crates/*）。
 * 依据：根 AGENTS.md「TS 冻结清单」+ CODEX_MIGRATION_PLAN.md §5。目标：收编/退役。
 */
import {
  flushSync,
  setContext,
  shutdown,
  track as trackEvent,
  withContext,
} from './client';
import type { TelemetryProperties as TelemetryPropertiesType } from './types';
import type { TelemetryContextIds, TelemetryClient } from './client';

export function track(event: string, properties: TelemetryPropertiesType = {}): void {
  trackEvent(event, properties);
}

export function setTelemetryContext(patch: TelemetryContextIds): void {
  setContext(patch);
}

export function withTelemetryContext(patch: TelemetryContextIds): TelemetryClient {
  return withContext(patch);
}

export function flushTelemetrySync(): void {
  flushSync();
}

export async function shutdownTelemetry(
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  await shutdown(options);
}

export { initializeTelemetry } from './bootstrap';
export type { TelemetryBootstrapOptions } from './bootstrap';

export { installCrashHandlers, setCrashPhase } from './crash';
export type { CrashPhase } from './crash';

export { normalizeRemote } from './remote';

export type { TelemetryPrimitive, TelemetryProperties } from './types';
export type { TelemetryClient, TelemetryContextIds } from './client';
