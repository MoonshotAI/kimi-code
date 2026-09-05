import type { Session } from '@moonshot-ai/kimi-code-sdk';

import {
  NO_ACTIVE_SESSION_MESSAGE,
  TOWER_STATUS_PROMPT,
  TOWER_TEARDOWN_PROMPT,
} from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleTowerCommand(host: SlashCommandHost, args: string): Promise<void> {
  const input = args.trim();
  const sub = input.toLowerCase();

  if (sub === 'on') {
    await applyTowerMode(host, true);
    return;
  }
  if (sub === 'off') {
    await applyTowerMode(host, false);
    return;
  }
  if (sub === '' || sub === 'status') {
    host.sendNormalUserInput(TOWER_STATUS_PROMPT);
    return;
  }
  if (sub === 'teardown') {
    host.sendNormalUserInput(TOWER_TEARDOWN_PROMPT);
    return;
  }

  await startTowerWithBase(host, input);
}

async function startTowerWithBase(host: SlashCommandHost, base: string): Promise<void> {
  // `/tower <base>` is manual activation too: it turns tower mode on and pins
  // the branch missions merge back into (the engine validates that it is a
  // local branch). Only the agent can never enter the mode by itself.
  const wasActive = host.state.appState.towerMode;
  if (!(await setTowerMode(host, true, base))) return;
  host.showNotice(wasActive ? `Tower base: ${base}` : `Tower mode: ON (base: ${base})`);
}

async function applyTowerMode(host: SlashCommandHost, enabled: boolean): Promise<void> {
  const wasActive = host.state.appState.towerMode;
  // The setter is idempotent engine-side, so always reassert — a stale cache
  // must not leave the authoritative mode unchanged.
  if (!(await setTowerMode(host, enabled))) return;
  if (wasActive === enabled) {
    host.showStatus(`Tower mode is already ${enabled ? 'on' : 'off'}.`);
    return;
  }
  host.showNotice(enabled ? 'Tower mode: ON' : 'Tower mode: OFF');
}

async function setTowerMode(
  host: SlashCommandHost,
  enabled: boolean,
  base?: string,
): Promise<boolean> {
  const session = await requireSessionEnsured(host);
  if (session === undefined) return false;
  try {
    await session.setTowerMode(enabled, base);
    // The engine may silently refuse entry (flag off, feature not assembled
    // until a restart, another session owning the workspace tower) — confirm
    // the mode actually took before reporting success.
    const status = await session.getStatus();
    const effective = status.towerMode ?? false;
    if (effective !== enabled) {
      host.setAppState({ towerMode: effective });
      host.showError(
        enabled
          ? 'Tower mode could not be enabled — another session owns this workspace tower, or the experiment is off / was just turned on and needs a restart.'
          : 'Tower mode could not be disabled.',
      );
      return false;
    }
  } catch (error) {
    host.showError(
      `Failed to ${enabled ? 'enable' : 'disable'} tower mode: ${formatErrorMessage(error)}`,
    );
    return false;
  }
  host.setAppState({ towerMode: enabled });
  return true;
}

async function requireSessionEnsured(host: SlashCommandHost): Promise<Session | undefined> {
  if (host.session !== undefined) return host.session;
  if (!host.engineV2) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return undefined;
  }
  // v2 session-less: lazy-create the session, then toggle — the same path
  // the first prompt takes.
  return host.ensureSession();
}
