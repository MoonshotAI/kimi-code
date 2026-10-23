import { setTelemetryContext, track, withTelemetryContext } from '@moonshot-ai/kimi-telemetry';
import { createKimiHarness, type TelemetryClient } from '@moonshot-ai/kimi-code-sdk';
import { ProcessTerminal, TuiMainScreen } from '@moonshot-ai/pi-tui';
import type { Command } from 'commander';

import { createCliTelemetryBootstrap } from '#/cli/telemetry';
import { createKimiCodeHostIdentity } from '#/cli/version';

import { importBudget, importSessions, scanImportableSessions, sourceHomes } from './run-import';
import { ImportSessionsScreenComponent } from './screen';

export function registerImportSessionsCommand(
  parent: Command,
  run: () => Promise<number> = runImportSessionsCommand,
): void {
  parent
    .command('import-sessions')
    .description('Import recent Claude Code and Codex sessions into Kimi Code.')
    .action(async () => {
      process.exitCode = await run();
    });
}

/** `kimi import-sessions`: show only the import page in a bare terminal UI, then exit. */
export async function runImportSessionsCommand(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('kimi import-sessions needs an interactive terminal.\n');
    return 1;
  }
  const telemetry: TelemetryClient = { track, withContext: withTelemetryContext, setContext: setTelemetryContext };
  const harness = createKimiHarness({
    homeDir: createCliTelemetryBootstrap().homeDir,
    identity: createKimiCodeHostIdentity(),
    telemetry,
  });
  try {
    const kimiHome = harness.homeDir;
    const budget = importBudget(await harness.getConfig().catch(() => ({})));
    const now = Date.now();
    const homes = sourceHomes();
    const ui = new TuiMainScreen(new ProcessTerminal());
    await new Promise<void>((resolve) => {
      const screen = new ImportSessionsScreenComponent({
        now,
        scan: () => scanImportableSessions({ kimiHome, ...homes, now }),
        run: (candidates, hooks) => importSessions(candidates, { kimiHome, ...budget, now, ...hooks }),
        requestRender: () => {
          ui.requestRender();
        },
        onClose: () => {
          resolve();
        },
      });
      ui.addChild(screen);
      ui.setFocus(screen);
      ui.start();
    });
    ui.stop();
    return 0;
  } finally {
    await harness.close();
  }
}
