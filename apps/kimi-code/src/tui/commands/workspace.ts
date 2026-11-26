import {
  BUSINESS_MEMBERSHIP_REVOKED_MESSAGE,
  isBusinessMembershipRevokedCode,
  type ManagedWorkspace,
} from '@moonshot-ai/kimi-code-sdk';

import { WorkspaceSelectorComponent } from '../components/dialogs/workspace-selector';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const NOT_LOGGED_IN_MESSAGE = 'Not logged in to Kimi Code. Send /login to authenticate.';
const NO_BUSINESS_WORKSPACES_MESSAGE = 'No business workspaces available for this account.';

function workspaceSelectionLabel(workspace: ManagedWorkspace): string {
  if (workspace.kind === 'business') return workspace.name;
  return workspace.name.length > 0 && workspace.name !== 'Personal'
    ? `${workspace.name} · Personal workspace`
    : 'Personal workspace';
}

function promptWorkspaceSelection(
  host: SlashCommandHost,
  workspaces: readonly ManagedWorkspace[],
): Promise<ManagedWorkspace | undefined> {
  return new Promise((resolve) => {
    const selector = new WorkspaceSelectorComponent({
      workspaces,
      onSelect: (workspace) => {
        host.restoreEditor();
        resolve(workspace);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(selector, undefined, () => {
      resolve(undefined);
    });
  });
}

export async function handleWorkspaceCommand(host: SlashCommandHost): Promise<void> {
  const status = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const hasToken = status.providers.some(
    (provider) => provider.providerName === DEFAULT_OAUTH_PROVIDER_NAME && provider.hasToken,
  );
  if (!hasToken) {
    host.showError(NOT_LOGGED_IN_MESSAGE);
    return;
  }

  const listResult = await host.harness.auth.listWorkspaces(DEFAULT_OAUTH_PROVIDER_NAME);
  if (listResult.kind === 'error') {
    if (isBusinessMembershipRevokedCode(listResult.errorCode)) {
      host.authFlow.handleBusinessMembershipRevoked();
    }
    host.showError(listResult.message);
    return;
  }

  const hasBusinessWorkspace = listResult.workspaces.some((ws) => ws.kind === 'business');
  if (!hasBusinessWorkspace) {
    host.setAppState({ managedWorkspace: { hasBusinessWorkspace: false } });
    host.showStatus(NO_BUSINESS_WORKSPACES_MESSAGE);
    return;
  }

  const chosen = await promptWorkspaceSelection(host, listResult.workspaces);
  if (chosen === undefined) return;

  const targetLabel = workspaceSelectionLabel(chosen);
  if (chosen.current) {
    host.showStatus(`Already in ${targetLabel}.`);
    return;
  }

  const releaseAuthBlock = host.beginAuthBlock();
  const spinner = host.showLoginProgressSpinner(`Switching to ${targetLabel}…`);
  try {
    const switched = await host.authFlow.switchWorkspace(chosen.target, chosen);
    spinner.stop({
      ok: true,
      label: `Switched to ${switched.displayName}. Usage will be billed accordingly.`,
    });
    if (switched.warning !== undefined) {
      host.showStatus(`Warning: ${switched.warning}`, 'warning');
    }
  } catch (error) {
    spinner.stop({ ok: false, label: 'Workspace switch failed.' });
    const message = formatErrorMessage(error);
    if (message === BUSINESS_MEMBERSHIP_REVOKED_MESSAGE) {
      host.authFlow.handleBusinessMembershipRevoked();
      host.showError(BUSINESS_MEMBERSHIP_REVOKED_MESSAGE);
    } else {
      host.showError(`Failed to switch workspace: ${message}`);
    }
  } finally {
    releaseAuthBlock();
  }
}
