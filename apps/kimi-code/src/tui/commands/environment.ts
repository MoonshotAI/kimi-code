import type { Session, SessionEnvironmentsInfo } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  EnvironmentAddDialogComponent,
  type EnvironmentAddType,
  type EnvironmentAddValue,
} from '../components/dialogs/environment-add-dialog';
import { EnvironmentCwdDialogComponent } from '../components/dialogs/environment-cwd-dialog';
import {
  EnvironmentManagerComponent,
  type EnvironmentManagerEnvironment,
} from '../components/dialogs/environment-manager';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const environmentManagerGenerations = new WeakMap<object, number>();

// ---------------------------------------------------------------------------
// /environment command
// ---------------------------------------------------------------------------

export async function handleEnvironmentCommand(host: SlashCommandHost): Promise<void> {
  const session = host.requireSession();
  await openEnvironmentManager(host, session);
}

/** Structural minimum shared by the manager and the sub-dialogs. */
interface ActionFeedback {
  setBusy(message: string): void;
  showError(message: string): void;
}

async function openEnvironmentManager(host: SlashCommandHost, session: Session): Promise<void> {
  const generation = (environmentManagerGenerations.get(host) ?? 0) + 1;
  environmentManagerGenerations.set(host, generation);
  let list: SessionEnvironmentsInfo | undefined;
  let currentEnvironmentId = 'local';
  let manager!: EnvironmentManagerComponent;
  const managerOptions = {
    environments: [],
    currentEnvironmentId,
    onSwitch: (environmentId) => {
      if (list === undefined) return;
      void switchFlow(host, session, manager, list, currentEnvironmentId, environmentId);
    },
    onReconnect: () => {
      if (list === undefined) return;
      void reconnectFlow(host, session, manager, currentEnvironmentId);
    },
    onAdd: () => {
      if (list !== undefined) void addFlow(host, session, list);
    },
    onClose: () => {
      if (environmentManagerGenerations.get(host) !== generation) return;
      environmentManagerGenerations.set(host, generation + 1);
      host.restoreEditor();
    },
    requestRender: () => {
      host.requestRender();
    },
  } satisfies ConstructorParameters<typeof EnvironmentManagerComponent>[0];
  manager = new EnvironmentManagerComponent(managerOptions);
  host.mountEditorReplacement(manager);
  manager.setBusy('Loading environments…');

  try {
    const [loadedList, binding] = await Promise.all([
      session.listEnvironments(),
      session.getEnvironment(),
    ]);
    if (environmentManagerGenerations.get(host) !== generation) return;
    list = loadedList;
    currentEnvironmentId = binding.environmentId;
    manager.setOptions({
      ...managerOptions,
      environments: toManagerEnvironments(list),
      currentEnvironmentId,
    }, { selectCurrent: true });
  } catch (error) {
    if (environmentManagerGenerations.get(host) === generation) {
      manager.showError(formatErrorMessage(error));
    }
  }
}

function toManagerEnvironments(list: SessionEnvironmentsInfo): readonly EnvironmentManagerEnvironment[] {
  return list.environments.map((environment) => ({
    environmentId: environment.environmentId,
    type: environment.type,
    status: environment.status,
    defaultCwd: environment.defaultCwd,
    connectError: environment.connectError,
  }));
}

// ---------------------------------------------------------------------------
// Switch (spec §7: cwd input → connect → target-fs validation → persist)
// ---------------------------------------------------------------------------

async function switchFlow(
  host: SlashCommandHost,
  session: Session,
  manager: EnvironmentManagerComponent,
  list: SessionEnvironmentsInfo,
  currentEnvironmentId: string,
  environmentId: string,
): Promise<void> {
  if (environmentId === currentEnvironmentId) return;
  const environment = list.environments.find((entry) => entry.environmentId === environmentId);
  if (environment === undefined) return;

  if (environmentId === 'local') {
    await doSwitchEnvironment(host, session, manager, 'local', undefined);
    return;
  }

  // Remote environments bind a (environmentId, cwd) pair: the cwd is collected here
  // (prefilled from the declaration's defaultCwd) and validated server-side
  // against the target fs — no local validation, no path completion.
  const dialog = new EnvironmentCwdDialogComponent({
    title: `Switch to ${environment.type}:${environment.environmentId}`,
    defaultValue: environment.defaultCwd ?? '',
    onSubmit: (cwd) => {
      void doSwitchEnvironment(host, session, dialog, environmentId, cwd);
    },
    onCancel: () => {
      void openEnvironmentManager(host, session);
    },
    requestRender: () => {
      host.requestRender();
    },
  });
  host.mountEditorReplacement(dialog);
}

async function doSwitchEnvironment(
  host: SlashCommandHost,
  session: Session,
  feedback: ActionFeedback,
  environmentId: string,
  cwd: string | undefined,
): Promise<void> {
  feedback.setBusy(environmentId === 'local' ? 'Switching to local…' : `Connecting to ${environmentId}…`);
  try {
    await session.switchEnvironment(environmentId, cwd === undefined ? undefined : { cwd });
  } catch (error) {
    // Handshake failures carry the exit code and bounded stderr; cwd
    // validation failures name the offending path — both stay inline.
    feedback.showError(formatErrorMessage(error));
    return;
  }
  host.restoreEditor();
  host.showStatus(environmentId === 'local' ? 'Environment switched to local.' : `Environment switched to ${environmentId}.`);
  await host.refreshEnvironmentSlot();
}

// ---------------------------------------------------------------------------
// Reconnect (explicit, bound environment only)
// ---------------------------------------------------------------------------

async function reconnectFlow(
  host: SlashCommandHost,
  session: Session,
  manager: EnvironmentManagerComponent,
  currentEnvironmentId: string,
): Promise<void> {
  manager.setBusy(`Reconnecting ${currentEnvironmentId}…`);
  try {
    await session.reconnectEnvironment();
  } catch (error) {
    manager.showError(formatErrorMessage(error));
    return;
  }
  await host.refreshEnvironmentSlot();
  const list = await session.listEnvironments();
  manager.setOptions({
    environments: toManagerEnvironments(list),
    currentEnvironmentId,
    onSwitch: (nextId) => {
      void switchFlow(host, session, manager, list, currentEnvironmentId, nextId);
    },
    onReconnect: () => {
      void reconnectFlow(host, session, manager, currentEnvironmentId);
    },
    onAdd: () => {
      void addFlow(host, session, list);
    },
    onClose: () => {
      host.restoreEditor();
    },
    requestRender: () => {
      host.requestRender();
    },
  });
}

// ---------------------------------------------------------------------------
// Add (declare an environment in config.toml [environments])
// ---------------------------------------------------------------------------

const ADD_TYPE_OPTIONS = [
  { value: 'ssh', label: 'SSH host', description: 'ssh <host> — user, key, and proxy resolve via ~/.ssh/config' },
  { value: 'docker', label: 'Docker container', description: 'docker exec into a running container' },
  { value: 'command', label: 'Custom command', description: 'Any launcher command (orb, kubectl, …)' },
] as const;

const CUSTOM_HOST_VALUE = '__custom__';

async function addFlow(host: SlashCommandHost, session: Session, list: SessionEnvironmentsInfo): Promise<void> {
  const type = await promptChoice(host, 'Add environment', ADD_TYPE_OPTIONS);
  if (type === undefined) {
    await openEnvironmentManager(host, session);
    return;
  }

  // ssh hosts discovered from ~/.ssh/config prefill the form's host field;
  // the form still accepts a free-text host via the "Custom host" entry.
  let initialTarget: string | undefined;
  if (type === 'ssh' && list.sshHosts.length > 0) {
    const hostChoice = await promptChoice(host, 'SSH host', [
      ...list.sshHosts.map((candidate) => ({ value: candidate, label: candidate })),
      { value: CUSTOM_HOST_VALUE, label: 'Custom host…', description: 'Enter a host manually' },
    ]);
    if (hostChoice === undefined) {
      await openEnvironmentManager(host, session);
      return;
    }
    if (hostChoice !== CUSTOM_HOST_VALUE) initialTarget = hostChoice;
  }

  const existingIds = list.environments.map((environment) => environment.environmentId);
  const value = await new Promise<EnvironmentAddValue | undefined>((resolve) => {
    const dialog = new EnvironmentAddDialogComponent({
      type: type as EnvironmentAddType,
      existingIds,
      initialTarget,
      onSubmit: (submitted) => {
        void submitAdd(session, dialog, submitted, resolve);
      },
      onCancel: () => {
        resolve(undefined);
      },
      requestRender: () => {
        host.requestRender();
      },
    });
    host.mountEditorReplacement(dialog);
  });

  if (value === undefined) {
    await openEnvironmentManager(host, session);
    return;
  }
  host.showStatus(`Environment "${value.id}" added to config.toml.`);
  await openEnvironmentManager(host, session);
}

async function submitAdd(
  session: Session,
  feedback: ActionFeedback,
  value: EnvironmentAddValue,
  resolve: (value: EnvironmentAddValue | undefined) => void,
): Promise<void> {
  feedback.setBusy('Writing config.toml…');
  try {
    // The engine deep-merges the entry into the [environments] declarations
    // and validates them on write.
    await session.declareEnvironment({ id: value.id, entry: value.entry });
  } catch (error) {
    feedback.showError(formatErrorMessage(error));
    return;
  }
  resolve(value);
}

function promptChoice(
  host: SlashCommandHost,
  title: string,
  options: readonly { value: string; label: string; description?: string }[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title,
      options,
      onSelect: (value) => {
        resolve(value);
      },
      onCancel: () => {
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}
