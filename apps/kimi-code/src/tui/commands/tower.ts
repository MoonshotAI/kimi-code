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

  await startTowerObjective(host, input);
}

async function startTowerObjective(host: SlashCommandHost, objective: string): Promise<void> {
  const wasActive = host.state.appState.towerMode;
  // The engine's enter is idempotent, so never let the cached state skip the
  // mutation: it may be stale (mode changed elsewhere or an unlanded event).
  if (!(await setTowerMode(host, true))) return;
  if (!wasActive) host.showNotice('Tower mode: ON');
  host.sendNormalUserInput(objective);
}

async function applyTowerMode(host: SlashCommandHost, enabled: boolean): Promise<void> {
  if (enabled && host.state.appState.towerMode) {
    host.showStatus('Tower mode is already on.');
    return;
  }
  if (!enabled && !host.state.appState.towerMode) {
    host.showStatus('Tower mode is already off.');
    return;
  }
  if (!(await setTowerMode(host, enabled))) return;
  host.showNotice(enabled ? 'Tower mode: ON' : 'Tower mode: OFF');
}

async function setTowerMode(host: SlashCommandHost, enabled: boolean): Promise<boolean> {
  const session = await requireSessionEnsured(host);
  if (session === undefined) return false;
  try {
    await session.setTowerMode(enabled);
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
