import type { KimiConfig } from './schema';

/**
 * Print-mode (`kimi -p`) defaults for the v1 engine. A headless run should not
 * be cut short by limits meant for interactive use, so every value here is
 * "effectively unbounded". Explicit user config always wins over these.
 */

/**
 * Wall-clock ceiling (seconds) for the drain/steer wait once the main turn
 * ends: 10 years ≈ unbounded.
 */
export const PRINT_WAIT_CEILING_S_DEFAULT = 315_360_000;

/** Cap on extra turns steered by background-task completions: ≈ unbounded. */
export const PRINT_MAX_TURNS_DEFAULT = 100_000;

/**
 * Per-subagent (`Agent` / `AgentSwarm`, foreground and background) timeout:
 * `0` = no timeout (the interactive default is 2 hours). A headless run must
 * never have a subagent killed by a wall-clock cap; only the model itself may
 * stop one.
 */
export const PRINT_SUBAGENT_TIMEOUT_MS_DEFAULT = 0;

/**
 * Background Bash task timeout: `0` = no timeout (the interactive default is
 * 600s). Also covers foreground commands re-armed after being moved to the
 * background on timeout, so a headless run never kills a command it detached.
 */
export const PRINT_BASH_TASK_TIMEOUT_S_DEFAULT = 0;

/**
 * Merge print-mode defaults into the config bound to a new session. Only
 * values the user left unset are filled (per-key spread order).
 *
 * `background` gets only the `bashTaskTimeoutS` fill: the print background
 * *mode* defaults live next to the consuming code in `Session`
 * (`resolvePrintBackgroundMode`, `waitForBackgroundTasksOnPrint`,
 * `handlePrintMainTurnCompleted`), because `printBackgroundMode`'s fallback
 * must keep honoring the legacy `keep_alive_on_exit` → `'drain'` mapping.
 */
export function applyPrintModeConfigDefaults(config: KimiConfig): KimiConfig {
  return {
    ...config,
    // `0` is already what an unset maxStepsPerTurn means (unlimited); the
    // explicit value just pins the print-mode contract.
    loopControl: { maxStepsPerTurn: 0, ...config.loopControl },
    background: {
      bashTaskTimeoutS: PRINT_BASH_TASK_TIMEOUT_S_DEFAULT,
      ...config.background,
    },
    subagent: { timeoutMs: PRINT_SUBAGENT_TIMEOUT_MS_DEFAULT, ...config.subagent },
  };
}
