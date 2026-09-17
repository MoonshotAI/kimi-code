import type { KimiConfigPatch, Session, SessionRuntimesInfo } from '@moonshot-ai/kimi-code-sdk';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  RuntimeAddDialogComponent,
  type RuntimeAddType,
  type RuntimeAddValue,
} from '../components/dialogs/runtime-add-dialog';
import { RuntimeCwdDialogComponent } from '../components/dialogs/runtime-cwd-dialog';
import {
  RuntimeManagerComponent,
  type RuntimeManagerRuntime,
} from '../components/dialogs/runtime-manager';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// /runtime command (experimental remote runtime)
// ---------------------------------------------------------------------------

export async function handleRuntimeCommand(host: SlashCommandHost): Promise<void> {
  const session = host.requireSession();
  await openRuntimeManager(host, session);
}

/** Structural minimum shared by the manager and the sub-dialogs. */
interface ActionFeedback {
  setBusy(message: string): void;
  showError(message: string): void;
}

async function openRuntimeManager(host: SlashCommandHost, session: Session): Promise<void> {
  const [list, binding] = await Promise.all([session.listRuntimes(), session.getRuntime()]);
  const manager = new RuntimeManagerComponent({
    runtimes: toManagerRuntimes(list),
    currentRuntimeId: binding.runtimeId,
    onSwitch: (runtimeId) => {
      void switchFlow(host, session, manager, list, binding.runtimeId, runtimeId);
    },
    onReconnect: (runtimeId) => {
      void reconnectFlow(host, session, manager, binding.runtimeId, runtimeId);
    },
    onAdd: () => {
      void addFlow(host, session, list);
    },
    onClose: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(manager);
}

function toManagerRuntimes(list: SessionRuntimesInfo): readonly RuntimeManagerRuntime[] {
  return list.runtimes.map((runtime) => ({
    runtimeId: runtime.runtimeId,
    type: runtime.type,
    status: runtime.status,
    defaultCwd: runtime.defaultCwd,
  }));
}

// ---------------------------------------------------------------------------
// Switch (spec §7: cwd input → connect → target-fs validation → persist)
// ---------------------------------------------------------------------------

async function switchFlow(
  host: SlashCommandHost,
  session: Session,
  manager: RuntimeManagerComponent,
  list: SessionRuntimesInfo,
  currentRuntimeId: string,
  runtimeId: string,
): Promise<void> {
  if (runtimeId === currentRuntimeId) return;
  const runtime = list.runtimes.find((entry) => entry.runtimeId === runtimeId);
  if (runtime === undefined) return;

  if (runtimeId === 'local') {
    await doSwitchRuntime(host, session, manager, 'local', undefined);
    return;
  }

  // Remote runtimes bind a (runtimeId, cwd) pair: the cwd is collected here
  // (prefilled from the declaration's defaultCwd) and validated server-side
  // against the target fs — no local validation, no path completion.
  const dialog = new RuntimeCwdDialogComponent({
    title: `Switch to ${runtime.type}:${runtime.runtimeId}`,
    defaultValue: runtime.defaultCwd ?? '',
    onSubmit: (cwd) => {
      void doSwitchRuntime(host, session, dialog, runtimeId, cwd);
    },
    onCancel: () => {
      void openRuntimeManager(host, session);
    },
  });
  host.mountEditorReplacement(dialog);
}

async function doSwitchRuntime(
  host: SlashCommandHost,
  session: Session,
  feedback: ActionFeedback,
  runtimeId: string,
  cwd: string | undefined,
): Promise<void> {
  feedback.setBusy(runtimeId === 'local' ? 'Switching to local…' : `Connecting to ${runtimeId}…`);
  try {
    await session.switchRuntime(runtimeId, cwd === undefined ? undefined : { cwd });
  } catch (error) {
    // Handshake failures carry the exit code and bounded stderr; cwd
    // validation failures name the offending path — both stay inline.
    feedback.showError(formatErrorMessage(error));
    return;
  }
  host.restoreEditor();
  host.showStatus(runtimeId === 'local' ? 'Runtime switched to local.' : `Runtime switched to ${runtimeId}.`);
  await host.refreshRuntimeSlot();
}

// ---------------------------------------------------------------------------
// Reconnect (explicit, bound runtime only)
// ---------------------------------------------------------------------------

async function reconnectFlow(
  host: SlashCommandHost,
  session: Session,
  manager: RuntimeManagerComponent,
  currentRuntimeId: string,
  runtimeId: string,
): Promise<void> {
  if (runtimeId !== currentRuntimeId) return;
  manager.setBusy(`Reconnecting ${runtimeId}…`);
  try {
    await session.reconnectRuntime();
  } catch (error) {
    manager.showError(formatErrorMessage(error));
    return;
  }
  await host.refreshRuntimeSlot();
  const list = await session.listRuntimes();
  manager.setOptions({
    runtimes: toManagerRuntimes(list),
    currentRuntimeId,
    onSwitch: (nextId) => {
      void switchFlow(host, session, manager, list, currentRuntimeId, nextId);
    },
    onReconnect: (nextId) => {
      void reconnectFlow(host, session, manager, currentRuntimeId, nextId);
    },
    onAdd: () => {
      void addFlow(host, session, list);
    },
    onClose: () => {
      host.restoreEditor();
    },
  });
}

// ---------------------------------------------------------------------------
// Add (declare a runtime in config.toml [runtimes])
// ---------------------------------------------------------------------------

const ADD_TYPE_OPTIONS = [
  { value: 'ssh', label: 'SSH host', description: 'ssh <host> — user, key, and proxy resolve via ~/.ssh/config' },
  { value: 'docker', label: 'Docker container', description: 'docker exec into a running container' },
  { value: 'command', label: 'Custom command', description: 'Any launcher command (orb, kubectl, …)' },
] as const;

const CUSTOM_HOST_VALUE = '__custom__';

async function addFlow(host: SlashCommandHost, session: Session, list: SessionRuntimesInfo): Promise<void> {
  const type = await promptChoice(host, 'Add runtime', ADD_TYPE_OPTIONS);
  if (type === undefined) {
    await openRuntimeManager(host, session);
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
      await openRuntimeManager(host, session);
      return;
    }
    if (hostChoice !== CUSTOM_HOST_VALUE) initialTarget = hostChoice;
  }

  const existingIds = list.runtimes.map((runtime) => runtime.runtimeId);
  const value = await new Promise<RuntimeAddValue | undefined>((resolve) => {
    const dialog = new RuntimeAddDialogComponent({
      type: type as RuntimeAddType,
      existingIds,
      initialTarget,
      onSubmit: (submitted) => {
        void submitAdd(host, dialog, submitted, resolve);
      },
      onCancel: () => {
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(dialog);
  });

  if (value === undefined) {
    await openRuntimeManager(host, session);
    return;
  }
  // The engine watches the [runtimes] config section and registers new
  // declarations live; wait for the registration to land so the reopened
  // manager lists the new runtime immediately.
  host.showStatus(`Runtime "${value.id}" added to config.toml.`);
  await waitForRuntimeRegistration(session, value.id);
  await openRuntimeManager(host, session);
}

const REGISTRATION_WAIT_TIMEOUT_MS = 2_000;
const REGISTRATION_WAIT_INTERVAL_MS = 50;

async function waitForRuntimeRegistration(session: Session, runtimeId: string): Promise<void> {
  const deadline = Date.now() + REGISTRATION_WAIT_TIMEOUT_MS;
  for (;;) {
    const list = await session.listRuntimes();
    if (list.runtimes.some((runtime) => runtime.runtimeId === runtimeId) || Date.now() >= deadline) return;
    await new Promise((resolve) => {
      setTimeout(resolve, REGISTRATION_WAIT_INTERVAL_MS);
    });
  }
}

async function submitAdd(
  host: SlashCommandHost,
  feedback: ActionFeedback,
  value: RuntimeAddValue,
  resolve: (value: RuntimeAddValue | undefined) => void,
): Promise<void> {
  feedback.setBusy('Writing config.toml…');
  try {
    // The SDK patch schema predates the [runtimes] section; the engine
    // deep-merges the entry into the section and validates it on write.
    await host.harness.setConfig({
      runtimes: { [value.id]: value.entry },
    } as unknown as KimiConfigPatch);
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
