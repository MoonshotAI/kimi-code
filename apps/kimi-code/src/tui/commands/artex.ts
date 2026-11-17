import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleArtexCommand(host: SlashCommandHost, args: string): Promise<void> {
  const input = args.trim();
  const sub = input.toLowerCase();

  if (sub === '' || sub === 'dashboard' || sub === 'status') {
    if (sub === 'status') {
      const session = await requireSessionEnsured(host);
      if (session === undefined) return;
      try {
        const status = await session.getArtexStatus();
        host.showNotice('ARTEX status', JSON.stringify(status, null, 2));
      } catch (error) {
        host.showError(`Failed to read ARTEX status: ${formatErrorMessage(error)}`);
      }
      return;
    }
    await host.artexBrowserController.show();
    return;
  }

  if (sub === 'on') {
    await applyArtexMode(host, true);
    return;
  }
  if (sub === 'off') {
    await applyArtexMode(host, false);
    return;
  }
  if (sub === 'pause') {
    await controlArtex(host, 'pause');
    return;
  }
  if (sub === 'resume') {
    await controlArtex(host, 'resume');
    return;
  }
  if (sub === 'stop') {
    await controlArtex(host, 'stop');
    return;
  }
  if (sub.startsWith('report')) {
     const format = sub.split(/\s+/)[1] as 'markdown' | 'json' | 'csv' | undefined;
    const session = await requireSessionEnsured(host);
    if (session === undefined) return;
    try {
      const report = await session.exportArtexReport(
        format === undefined ? undefined : { format },
      );
      host.showNotice('ARTEX report', JSON.stringify(report, null, 2));
    } catch (error) {
      host.showError(`Failed to export ARTEX report: ${formatErrorMessage(error)}`);
    }
    return;
  }

  const session = await requireSessionEnsured(host);
  if (session === undefined) return;
  if (!(await applyArtexMode(host, true))) return;
  try {
    await session.startArtex({ goal: input });
    host.showNotice('ARTEX exploration started', input);
  } catch (error) {
    host.showError(`Failed to start ARTEX exploration: ${formatErrorMessage(error)}`);
  }
}

async function controlArtex(
  host: SlashCommandHost,
  action: 'pause' | 'resume' | 'stop',
): Promise<void> {
  const session = await requireSessionEnsured(host);
  if (session === undefined) return;
  try {
    await session.controlArtex({ action });
    host.showNotice(`ARTEX ${action}`);
  } catch (error) {
    host.showError(`Failed to ${action} ARTEX: ${formatErrorMessage(error)}`);
  }
}

async function applyArtexMode(host: SlashCommandHost, enabled: boolean): Promise<boolean> {
  const session = await requireSessionEnsured(host);
  if (session === undefined) return false;
  try {
    await session.setArtexMode(enabled);
    const status = await session.getStatus();
    const effective = status.artexMode ?? false;
    if (effective !== enabled) {
      host.setAppState({ artexMode: effective });
      host.showError(
        enabled
          ? 'ARTEX mode could not be enabled — the experiment is off or needs a restart.'
          : 'ARTEX mode could not be disabled.',
      );
      return false;
    }
  } catch (error) {
    host.showError(
      `Failed to ${enabled ? 'enable' : 'disable'} ARTEX mode: ${formatErrorMessage(error)}`,
    );
    return false;
  }
  host.setAppState({ artexMode: enabled });
  return true;
}

async function requireSessionEnsured(host: SlashCommandHost): Promise<Session | undefined> {
  if (host.session !== undefined) return host.session;
  return host.ensureSession();
}