import { destroyPanelContext, destroyPanelWorkspace } from '../panel/panelPersistence';
import { resetObservationScopes, sessionReadScope, workspaceReadScope } from './observationScope';

import type { AppEvent, DeviceRoutingControls, KimiWebApi } from '@moonshot-ai/app-core/api';
import type { Translator } from '@moonshot-ai/app-core/contracts';

export type SessionCreatedSource =
  | 'sidebar'
  | 'shortcut'
  | 'menu'
  | 'jump_list'
  | 'tray'
  | 'notification'
  | 'search'
  | 'slash_command';

export interface KimiClientDeps {
  api: () => KimiWebApi;
  t: Translator;
  traceClientEvent?: (label: string, detail?: unknown) => void;
  traceKeyEvent?: (event: string, info?: Record<string, unknown>) => void;
  sessionExportTraceToJsonl?: () => string;
  onSessionDestroyed?: (sessionId: string) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onSessionForked?: (sourceSessionId: string, targetSessionId: string) => Promise<void> | void;
  onWorkspaceDestroyed?: (workspaceId: string, root: string, sessionIds: string[]) => void;
  consumeSessionIntent?: (fallback: SessionCreatedSource) => SessionCreatedSource;
  onPluginsShelfEvent?: (event: AppEvent) => void;
}

const defaultDeps: KimiClientDeps = {
  api: () => {
    throw new Error('[@moonshot-ai/app-client] client deps not installed — call setKimiClientDeps() at app bootstrap');
  },
  t: (key) => key,
};

const cell = ((globalThis as { __kimiAppClientDeps?: { current: KimiClientDeps } }).__kimiAppClientDeps ??= {
  current: defaultDeps,
});

export function setKimiClientDeps(deps: KimiClientDeps): void {
  resetObservationScopes();
  cell.current = deps;
}

export function resetKimiClientDeps(): void {
  resetObservationScopes();
  cell.current = defaultDeps;
}

const lazyApi = new Proxy<KimiWebApi>({} as KimiWebApi, {
  get(_target, prop) {
    const api = cell.current.api() as unknown as Record<PropertyKey, unknown>;
    return api[prop];
  },
});

export function getKimiWebApi(): KimiWebApi {
  return lazyApi;
}

function deviceRouting(): Partial<DeviceRoutingControls> {
  if (cell.current === defaultDeps || cell.current.api === defaultDeps.api) return {};
  return (cell.current.api() as Partial<DeviceRoutingControls> | undefined) ?? {};
}

export function getDeviceApi(deviceId: string | undefined): KimiWebApi {
  const deviceApi = deviceRouting().deviceApi;
  if (deviceApi !== undefined) return deviceApi(deviceId);
  if (deviceId === undefined) return getKimiWebApi();
  throw new Error(`Device "${deviceId}" is unavailable without device routing`);
}

export function t(key: string, params?: Record<string, unknown>): string {
  return cell.current.t(key, params);
}

export function traceClientEvent(label: string, detail?: unknown): void {
  cell.current.traceClientEvent?.(label, detail);
}

export function traceKeyEvent(event: string, info?: Record<string, unknown>): void {
  cell.current.traceKeyEvent?.(event, info);
}

export function sessionExportTraceToJsonl(): string {
  return cell.current.sessionExportTraceToJsonl?.() ?? '';
}

export function notifySessionDestroyed(sessionId: string): void {
  sessionReadScope.forget(sessionId);
  destroyPanelContext(sessionId);
  cell.current.onSessionDestroyed?.(sessionId);
}

export function notifySessionDeleted(sessionId: string): void {
  cell.current.onSessionDeleted?.(sessionId);
}

export async function notifySessionForked(sourceSessionId: string, targetSessionId: string): Promise<void> {
  await cell.current.onSessionForked?.(sourceSessionId, targetSessionId);
}

export function notifyWorkspaceDestroyed(workspaceId: string, root: string, sessionIds: string[]): void {
  workspaceReadScope.forget(workspaceId);
  destroyPanelWorkspace(workspaceId);
  for (const sessionId of sessionIds) {
    sessionReadScope.forget(sessionId);
    destroyPanelContext(sessionId);
  }
  cell.current.onWorkspaceDestroyed?.(workspaceId, root, sessionIds);
}

export function consumeSessionIntent(fallback: SessionCreatedSource): SessionCreatedSource {
  return cell.current.consumeSessionIntent?.(fallback) ?? fallback;
}

export function notifyPluginsShelfEvent(event: AppEvent): boolean {
  if (!cell.current.onPluginsShelfEvent) return false;
  cell.current.onPluginsShelfEvent(event);
  return true;
}

let archivedSettingsOpener: (() => void) | null = null;

export function registerArchivedSettingsOpener(opener: () => void): void {
  archivedSettingsOpener = opener;
}

export function openArchivedSettings(): void {
  archivedSettingsOpener?.();
}

let modelPickerOpener: ((sessionId?: string) => Promise<void>) | null = null;

export function registerModelPickerOpener(opener: (sessionId?: string) => Promise<void>): void {
  modelPickerOpener = opener;
}

export async function openModelPicker(sessionId?: string): Promise<void> {
  await modelPickerOpener?.(sessionId);
}
