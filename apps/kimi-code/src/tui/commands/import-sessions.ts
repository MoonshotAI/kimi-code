import {
  ImportSessionsScreenComponent,
  importBudget,
  importSessions,
  scanImportableSessions,
  sourceHomes,
} from '#/session-import/index';

import type { SlashCommandHost } from './dispatch';

export function handleImportSessionsCommand(host: SlashCommandHost): void {
  const now = Date.now();
  const kimiHome = host.harness.homeDir;
  const homes = sourceHomes();
  const screen = new ImportSessionsScreenComponent({
    now,
    scan: () => scanImportableSessions({ kimiHome, ...homes, now }),
    run: async (candidates, hooks) => {
      const budget = importBudget(await host.harness.getConfig().catch(() => ({})));
      const report = await importSessions(candidates, { kimiHome, ...budget, now, ...hooks });
      await Promise.all(
        report.imported.map((sessionId) => host.harness.listSessions({ sessionId }).catch(() => [])),
      );
      return report;
    },
    requestRender: () => {
      host.state.ui.requestRender();
    },
    onClose: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(screen);
}
