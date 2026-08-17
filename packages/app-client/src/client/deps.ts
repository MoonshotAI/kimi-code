// packages/app-client/src/client/deps.ts
// Platform injection seam for the client singletons (useKimiWebClient /
// useWorkspaceState). The application registers its implementations once at
// bootstrap (the composition root, main.ts); the client modules only ever see
// these delegates. Optional hooks default to no-ops, which reproduces the web
// app's behavior (no native terminal, no session intent, no plugins shelf).

import type { AppEvent, KimiWebApi } from '@moonshot-ai/app-core/api';
import type { Translator } from '@moonshot-ai/app-core/contracts';

/** Source attribution for the session_created telemetry event — mirrors the
    desktop main-process zod enum (apps/desktop/src/shared/track-events.ts);
    that schema stays the runtime validation boundary. */
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
  /** Accessor for the app's composed KimiWebApi singleton. */
  api: () => KimiWebApi;
  /** Translator bound to the app's vue-i18n global scope. */
  t: Translator;
  /** Client-lifecycle trace records (the app's debug/trace ring). */
  traceClientEvent?: (label: string, detail?: unknown) => void;
  traceKeyEvent?: (event: string, info?: Record<string, unknown>) => void;
  sessionExportTraceToJsonl?: () => string;
  /** A session was deleted (or archived remotely) — tear down its native
      terminal PTY. Desktop-only; web leaves unset. */
  onSessionDestroyed?: (sessionId: string) => void;
  /** A workspace was deleted remotely — tear down the given sessions'
      terminals plus the workspace's draft terminal. Desktop-only. */
  onWorkspaceDestroyed?: (workspaceId: string, root: string, sessionIds: string[]) => void;
  /** Claim a pending entry-point intent for session_created attribution
      (desktop telemetry). Defaults to the caller's fallback. */
  consumeSessionIntent?: (fallback: SessionCreatedSource) => SessionCreatedSource;
  /** Plugin/capability lifecycle fan-out for the settings plugins shelf
      (desktop). When unset (web), those events flow through the normal
      reducer path instead of being consumed. */
  onPluginsShelfEvent?: (event: AppEvent) => void;
}

const defaultDeps: KimiClientDeps = {
  api: () => {
    throw new Error('[@moonshot-ai/app-client] client deps not installed — call setKimiClientDeps() at app bootstrap');
  },
  t: (key) => key,
};

// The registry cell lives on globalThis so a test that re-imports the client
// modules through a fresh module graph (vi.resetModules) still sees the same
// registry as the test file's statically imported setKimiClientDeps.
const cell = ((globalThis as { __kimiAppClientDeps?: { current: KimiClientDeps } }).__kimiAppClientDeps ??= {
  current: defaultDeps,
});

/** Install the app's implementations once at bootstrap (composition root). */
export function setKimiClientDeps(deps: KimiClientDeps): void {
  cell.current = deps;
}

/** Restore the un-registered defaults (test isolation). */
export function resetKimiClientDeps(): void {
  cell.current = defaultDeps;
}

// Internal delegates consumed by the client modules — they keep the names of
// the app-side modules they replace so call sites stay byte-identical.

/** Stable api handle: the client modules call getKimiWebApi() at module scope
    (sub-composable construction), which runs before the composition root has
    registered anything. Method lookups therefore resolve against the
    registered api at call time. */
const lazyApi = new Proxy<KimiWebApi>({} as KimiWebApi, {
  get(_target, prop) {
    const api = cell.current.api() as unknown as Record<PropertyKey, unknown>;
    return api[prop];
  },
});

export function getKimiWebApi(): KimiWebApi {
  return lazyApi;
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
  cell.current.onSessionDestroyed?.(sessionId);
}

export function notifyWorkspaceDestroyed(workspaceId: string, root: string, sessionIds: string[]): void {
  cell.current.onWorkspaceDestroyed?.(workspaceId, root, sessionIds);
}

export function consumeSessionIntent(fallback: SessionCreatedSource): SessionCreatedSource {
  return cell.current.consumeSessionIntent?.(fallback) ?? fallback;
}

/** Fan a pluginsChanged/capabilityChanged event out to the plugins shelf.
    Returns true when a handler consumed it (the caller must early-return). */
export function notifyPluginsShelfEvent(event: AppEvent): boolean {
  if (!cell.current.onPluginsShelfEvent) return false;
  cell.current.onPluginsShelfEvent(event);
  return true;
}
