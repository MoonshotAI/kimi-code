import type { PermissionMode } from '../client/types';
import { safeGetString, safeSetString, STORAGE_KEYS } from './storage';

export function permissionModeFromConfig(value: unknown): PermissionMode | undefined {
  return value === 'manual' || value === 'auto' || value === 'yolo' ? value : undefined;
}

export function loadStickyPermission(): PermissionMode {
  return permissionModeFromConfig(safeGetString(STORAGE_KEYS.permission)) ?? 'manual';
}

export function saveStickyPermission(mode: PermissionMode): void {
  safeSetString(STORAGE_KEYS.permission, mode);
}

export function loadStickyPermissionAt(): number {
  const raw = safeGetString(STORAGE_KEYS.permissionStickyAt);
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  if (raw === null && safeGetString(STORAGE_KEYS.permission) !== null) return 1;
  return 0;
}

export function saveStickyPermissionAt(at: number): void {
  safeSetString(STORAGE_KEYS.permissionStickyAt, String(at));
}

function loadPermissionMap(key: string): Record<string, PermissionMode> {
  const raw = safeGetString(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, PermissionMode> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const mode = permissionModeFromConfig(value);
      if (mode !== undefined) out[id] = mode;
    }
    return out;
  } catch {
    return {};
  }
}

function savePermissionMap(key: string, map: Record<string, PermissionMode>): void {
  safeSetString(key, JSON.stringify(map));
}

export function loadPermissionBySession(): Record<string, PermissionMode> {
  return loadPermissionMap(STORAGE_KEYS.permissionBySession);
}

export function savePermissionBySession(map: Record<string, PermissionMode>): void {
  savePermissionMap(STORAGE_KEYS.permissionBySession, map);
}
