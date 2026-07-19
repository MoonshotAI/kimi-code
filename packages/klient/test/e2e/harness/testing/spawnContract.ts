/**
 * Shared contract between `spawnServerProcess` (`serverProcess.ts`) and its
 * child entry point (`serverProcessMain.ts`). Kept dependency-free so both
 * sides can import it without pulling in kap-server.
 */

/** Env var carrying the child server's homeDir into `serverProcessMain`. */
export const SPAWN_SERVER_HOME_ENV = 'KIMI_E2E_SPAWN_SERVER_HOME';

/** One JSON line on the child's stdout once `startServer` resolved. */
export interface SpawnServerReadyMessage {
  readonly type: 'ready';
  readonly port: number;
  readonly home: string;
  /**
   * The child reports its OWN pid, and the spawner asserts it equals
   * `child.pid` — if the launch incantation ever reintroduces a wrapper
   * process (e.g. the tsx CLI, which forks a grandchild), signals delivered
   * via `kill()` would silently hit the wrong process.
   */
  readonly pid: number;
}

/** One JSON line on the child's stdout when booting failed. */
export interface SpawnServerErrorMessage {
  readonly type: 'error';
  readonly message: string;
}

export type SpawnServerMessage = SpawnServerReadyMessage | SpawnServerErrorMessage;
