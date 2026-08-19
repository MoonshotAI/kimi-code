import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleTowerCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.session === undefined) {
    if (!host.engineV2) {
      host.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }
    // v2 session-less: lazy-create the session, then toggle — the same path
    // the first prompt takes.
    const session = await host.ensureSession();
    if (session === undefined) return;
  }

  const input = args.trim().toLowerCase();
  if (input === 'on') {
    await applyTowerMode(host, true);
    return;
  }
  if (input === 'off') {
    await applyTowerMode(host, false);
    return;
  }
  if (input.length === 0) {
    await applyTowerMode(host, !host.state.appState.towerMode);
    return;
  }

  await startTowerObjective(host, args.trim());
}

async function startTowerObjective(host: SlashCommandHost, objective: string): Promise<void> {
  if (!host.state.appState.towerMode) {
    if (!(await setTowerMode(host, true))) return;
    host.showNotice('Tower mode: ON');
  }
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
  try {
    await host.requireSession().setTowerMode(enabled);
  } catch (error) {
    host.showError(
      `Failed to ${enabled ? 'enable' : 'disable'} tower mode: ${formatErrorMessage(error)}`,
    );
    return false;
  }
  host.setAppState({ towerMode: enabled });
  return true;
}
