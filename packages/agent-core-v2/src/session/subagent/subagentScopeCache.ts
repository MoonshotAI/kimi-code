import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Error2, ErrorCodes } from '#/errors';

export const SUBAGENT_SCOPE_CACHE_SIZE_ENV = 'KIMI_CODE_SUBAGENT_SCOPE_CACHE_SIZE';

export const SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV = 'KIMI_CODE_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS';

export const DEFAULT_SUBAGENT_SCOPE_CACHE_SIZE = 32;

export const DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS = 15_000;

export function resolveSubagentScopeCacheSize(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[SUBAGENT_SCOPE_CACHE_SIZE_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_SUBAGENT_SCOPE_CACHE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `${SUBAGENT_SCOPE_CACHE_SIZE_ENV} must be an integer, got ${JSON.stringify(raw)}.`,
      { details: { value: raw } },
    );
  }
  return Math.max(0, value);
}

export function resolveSubagentScopeEvictTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `${SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`,
      { details: { value: raw } },
    );
  }
  return value;
}

export interface ISessionSubagentScopeCacheService {
  readonly _serviceBrand: undefined;
}

export const ISessionSubagentScopeCacheService: ServiceIdentifier<ISessionSubagentScopeCacheService> =
  createDecorator<ISessionSubagentScopeCacheService>('sessionSubagentScopeCacheService');
