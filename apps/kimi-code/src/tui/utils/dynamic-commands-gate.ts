/**
 * Readiness gate for the dynamic (skill/plugin) slash-command catalog. While
 * the gate promise is pending, `dispatchInput` defers every submission so a
 * slash command typed right after startup still resolves against the loaded
 * catalog instead of falling through to the model as plain text.
 *
 * The gate resolves when the catalog load settles — success or failure, the
 * gate is infallible by construction so queued drains can never be dropped by
 * a rejection — or when the fallback timeout fires, whichever comes first. On
 * timeout `onTimeout` receives the user-facing warning and the gate clears
 * anyway: a wedged load (e.g. stuck IPC) must not queue input forever. A load
 * that settles after the timeout still applies its results; the gate only
 * bounds how long input dispatch waits.
 */

import { DYNAMIC_COMMANDS_READY_TIMEOUT_MS } from '#/tui/constant/kimi-tui';

export function createDynamicCommandsGate(
  load: Promise<unknown>,
  onTimeout: (warning: string) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settle();
      onTimeout(
        'Skill and plugin catalogs are still loading — slash commands may be incomplete for a moment.',
      );
    }, DYNAMIC_COMMANDS_READY_TIMEOUT_MS);
    // Never hold the process open for the fallback: quitting while a catalog
    // load is wedged must not wait out the timer.
    timer.unref();
    function settle(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // oxlint-disable-next-line promise/no-multiple-resolved -- `settled` guards the single resolve; the rule cannot see it
      resolve();
    }
    void load.then(settle, settle);
  });
}
