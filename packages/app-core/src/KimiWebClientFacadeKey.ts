import type { InjectionKey } from 'vue';

/**
 * Facade that `apps/web` provides under {@link KimiWebClientFacadeKey} and that
 * (future) `web-shell` components inject instead of importing the
 * `useKimiWebClient` composable.
 *
 * The provided value is the existing `useKimiWebClient()` module singleton. Its
 * reactive state derives from {@link KimiClientState} but is exposed as Vue
 * refs/computed over app-specific *view* shapes (e.g. sidebar session rows,
 * chat turns), so members are typed loosely and kept optional: the full
 * singleton satisfies the contract without a cast, and consumers narrow the
 * fields they read.
 *
 * This is a representative subset of the shell surface; extend it as more
 * `web-shell` components sink down from `apps/web`.
 */
export interface KimiWebClientFacade {
  // Reactive state / computed view props (read via `.value`).
  sessions?: unknown;
  activeSessionId?: unknown;
  sessionsForView?: unknown;
  activeWorkspaceId?: unknown;
  turns?: unknown;
  status?: unknown;
  models?: unknown;
  messagesBySession?: unknown;

  // Shell actions (grounded from apps/web App.vue -> Sidebar / ConversationPane).
  // `(...args: never[]) => unknown` is the "any function" supertype: under
  // strictFunctionTypes the singleton's specific action signatures stay
  // assignable (contravariant params), unlike `(...args: unknown[]) => unknown`.
  load?: (...args: never[]) => unknown;
  sendPrompt?: (...args: never[]) => unknown;
  selectSession?: (...args: never[]) => unknown;
  openWorkspace?: (...args: never[]) => unknown;
  setModel?: (...args: never[]) => unknown;
  setActiveSessionId?: (id: string | undefined) => void;
}

export const KimiWebClientFacadeKey: InjectionKey<KimiWebClientFacade> = Symbol('KimiWebClientFacade');
