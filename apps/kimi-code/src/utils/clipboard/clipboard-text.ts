import { spawn } from 'node:child_process';

import { resolveCommandPath } from '#/utils/process/resolve-command';

import { isWaylandSession, isWSL } from './clipboard-common';
import { clipboard } from './clipboard-native';
import { writeClipboardOSC52 } from './clipboard-osc52';

const CLIPBOARD_COMMAND_TIMEOUT_MS = 5000;

export type ClipboardCopyMethod = 'native' | 'osc52';

export interface ClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ClipboardWritePlan {
  readonly nativeModule: boolean;
  readonly commands: readonly ClipboardCommand[];
  readonly osc52: 'always' | 'fallback' | 'never';
  readonly unavailableMessage: string;
}

interface UnixClipboardBackend {
  readonly present: (env: NodeJS.ProcessEnv) => boolean;
  readonly commands: readonly ClipboardCommand[];
  readonly unavailableMessage: string;
}

const UNIX_CLIPBOARD_BACKENDS: readonly UnixClipboardBackend[] = [
  {
    present: (env) => Boolean(env['TERMUX_VERSION']),
    commands: [{ command: 'termux-clipboard-set', args: [] }],
    unavailableMessage: 'Clipboard unavailable: install the Termux:API app and `termux-api` package',
  },
  {
    present: isWaylandSession,
    commands: [{ command: 'wl-copy', args: [] }],
    unavailableMessage: 'Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access',
  },
  {
    present: (env) => Boolean(env['DISPLAY']),
    commands: [
      { command: 'xclip', args: ['-selection', 'clipboard'] },
      { command: 'xsel', args: ['--clipboard', '--input'] },
    ],
    unavailableMessage: 'Clipboard unavailable: install `xclip` or `xsel`, or check X11 access',
  },
];

const REMOTE_SESSION_ENV = ['SSH_CONNECTION', 'SSH_CLIENT', 'MOSH_CONNECTION'];

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
  return REMOTE_SESSION_ENV.some((name) => Boolean(env[name]));
}

export function planClipboardWrite(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ClipboardWritePlan {
  const forceOSC52 = isRemoteSession(env) || env['KIMI_CODE_CLIPBOARD_OSC52'] === '1';
  if (platform === 'darwin' || platform === 'win32') {
    return {
      nativeModule: true,
      commands: [{ command: platform === 'darwin' ? 'pbcopy' : 'clip.exe', args: [] }],
      osc52: forceOSC52 ? 'always' : 'never',
      unavailableMessage: 'Clipboard unavailable',
    };
  }
  const backends = UNIX_CLIPBOARD_BACKENDS.filter((backend) => backend.present(env));
  // Linux desktop terminals such as GNOME Terminal ignore OSC 52, so it only
  // backs up a missing tool where no display exists or the terminal (Windows
  // Terminal under WSL, Termux) is known to honor it.
  const osc52Fallback =
    backends.length === 0 || Boolean(env['TERMUX_VERSION']) || (platform === 'linux' && isWSL(env));
  return {
    // The native module reports success on Linux without holding the X11
    // selection, which leaves the clipboard empty; the CLI tools keep it.
    nativeModule: platform !== 'linux',
    commands: backends.flatMap((backend) => backend.commands),
    osc52: forceOSC52 ? 'always' : osc52Fallback ? 'fallback' : 'never',
    unavailableMessage: backends[0]?.unavailableMessage ?? 'Clipboard unavailable',
  };
}

function runClipboardCommand(command: string, args: readonly string[], input: string): Promise<boolean> {
  // A fullscreen selection can be copied before the workspace trust prompt is
  // answered, so a writer planted in the workspace must never run.
  const executable = resolveCommandPath(command);
  if (executable === undefined) return Promise.resolve(false);
  return new Promise((resolve) => {
    // Writers such as xclip fork a child that keeps owning the selection. Give
    // it no output pipes to hold open, and on POSIX a session of its own so
    // closing the terminal does not SIGHUP it and empty the clipboard.
    const child = spawn(executable, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      cwd: '/',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let settled = false;
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdin?.destroy();
      if (claim()) resolve(false);
    }, CLIPBOARD_COMMAND_TIMEOUT_MS);
    child.on('error', () => {
      if (claim()) resolve(false);
    });
    child.on('close', (code) => {
      if (claim()) resolve(code === 0);
    });
    // A writer may exit before consuming all of its input.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export async function copyTextToClipboard(text: string): Promise<ClipboardCopyMethod> {
  const plan = planClipboardWrite(process.platform, process.env);
  // Sent before the system clipboard is tried, so a stuck writer cannot hold it up.
  const osc52Sent = plan.osc52 === 'always' && writeClipboardOSC52(text);

  let copied = false;
  if (plan.nativeModule && clipboard?.setText !== undefined) {
    try {
      await clipboard.setText(text);
      copied = true;
    } catch {}
  }
  for (const { command, args } of plan.commands) {
    if (copied) break;
    copied = await runClipboardCommand(command, args, text);
  }

  if (copied) return 'native';
  if (osc52Sent || (plan.osc52 === 'fallback' && writeClipboardOSC52(text))) return 'osc52';
  throw new Error(plan.unavailableMessage);
}
