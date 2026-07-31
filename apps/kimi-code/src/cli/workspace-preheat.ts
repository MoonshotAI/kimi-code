/**
 * Workspace index preheating.
 *
 * Builds the Rust `WorkspaceIndex` once, off the hot path, so the first
 * Read tool call can return an instant prediction while the precise read
 * runs in the background. The index is stored inside the native module
 * (a process-global `Mutex<Option<WorkspaceIndex>>`), so a single build
 * serves all later `nativeWorkspaceIndexPredictRead` queries.
 *
 * This is best-effort: if the native module is unavailable, the build
 * throws, or the workspace is empty, callers silently degrade to
 * precise reads. Never blocks TUI first paint — the build is deferred
 * via `setImmediate` and the agent-core-v2 graph is loaded lazily so
 * the v1 prompt path stays free of the v2 module graph.
 */

/**
 * Build the workspace index for `workDir` in the background. Safe to call
 * multiple times — only the first call with a given root does real work;
 * the native module replaces the prior index atomically.
 *
 * Logs the indexed file count at info level; large workspaces (>5k files)
 * also emit a telemetry track so we can monitor preheating cost.
 */
export function preheatWorkspaceIndex(workDir: string): void {
  // Defer off the current synchronous flow (TUI first paint, prompt
  // dispatch) so the build never blocks startup. `setImmediate` runs
  // after the current Node microtask queue drains.
  setImmediate(() => {
    void preheatAsync(workDir);
  });
}

/**
 * Async preheat implementation. Imported lazily so the v1 prompt path
 * does not eagerly pull in the agent-core-v2 module graph.
 */
async function preheatAsync(workDir: string): Promise<void> {
  try {
    // Lazy import keeps the agent-core-v2 graph off the v1 hot path.
    const { tryNativeBuildWorkspaceIndex } = await import('@moonshot-ai/agent-core-v2');
    const fileCount = tryNativeBuildWorkspaceIndex(workDir);
    if (fileCount === undefined) {
      // Native module unavailable — silent degradation.
      return;
    }
    if (fileCount < 1) {
      return;
    }
    // Lazy import telemetry so it stays out of the startup path when
    // the native module is absent.
    const { withTelemetryContext } = await import('@moonshot-ai/kimi-telemetry');
    withTelemetryContext({}).track('workspace_index_preheat', {
      file_count: fileCount,
      large: fileCount > 5000,
    });
    // eslint-disable-next-line no-console
    console.error(`[workspace] indexed ${fileCount} files for read predictions`);
  } catch (error) {
    // Silent degradation: a failed build must not break the session — but
    // leave a breadcrumb so a permanently-broken preheat is observable.
    if (process.env['KIMI_DEBUG']) {
      // eslint-disable-next-line no-console
      console.error('[workspace] index preheat failed:', error);
    }
  }
}
