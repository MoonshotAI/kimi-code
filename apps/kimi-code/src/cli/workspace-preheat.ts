/**
 * Workspace index preheating — REMOVED.
 *
 * The preheated native `WorkspaceIndex` (agent-core-v2 `tryNativeBuildWorkspaceIndex` /
 * `tryNativeWorkspaceIndexPredictRead`) no longer exists in the v2 module graph.
 * The Rust engine's event-driven turn loop carries its own prediction support
 * (is_prediction fast-path + background precise results), so the host-side
 * preheat was a transitional optimization — it is dead wiring and must not be
 * re-created.
 */

export function preheatWorkspaceIndex(_workDir: string): void {
  // Intentionally empty. The native workspace index was removed upstream;
  // keep the call site as a no-op marker so nothing resurrects it.
}
