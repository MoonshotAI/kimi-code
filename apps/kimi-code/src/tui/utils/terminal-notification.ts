import { execFile } from 'node:child_process';

import type { Terminal } from '@moonshot-ai/pi-tui';

import { BEL, ESC, MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH, ST } from '#/tui/constant/terminal';
import type { TUIState } from '#/tui/tui-state';

export interface TerminalNotification {
  readonly title: string;
  readonly body?: string | undefined;
}

export interface EmitOptions {
  readonly supportsOsc9?: boolean;
  readonly insideTmux?: boolean;
  readonly windowsTerminal?: boolean;
}

export interface BuildOptions {
  readonly supportsOsc9: boolean;
  readonly insideTmux: boolean;
}

export function notifyTerminalOnce(
  state: TUIState,
  key: string,
  notification: TerminalNotification,
): void {
  const { enabled, condition } = state.appState.notifications;
  if (!enabled) return;
  if (state.terminalState.notificationKeys.has(key)) return;
  state.terminalState.notificationKeys.add(key);
  if (condition === 'unfocused' && state.terminalState.focused) return;
  emitTerminalNotification(state.terminal, notification, {
    supportsOsc9: state.terminalState.supportsOsc9,
    insideTmux: state.terminalState.insideTmux,
  });
}

export function emitTerminalNotification(
  terminal: Pick<Terminal, 'write'>,
  notification: TerminalNotification,
  options: EmitOptions = {},
): void {
  const supportsOsc9 = options.supportsOsc9 ?? supportsOsc9Notification();
  const sequences = buildTerminalNotificationSequences(notification, {
    supportsOsc9,
    insideTmux: options.insideTmux ?? isInsideTmux(),
  });
  for (const sequence of sequences) {
    terminal.write(sequence);
  }
  // Windows Terminal does not support OSC 9 (its OSC 9 is taken by ConEmu
  // progress semantics), so on the BEL fallback path we additionally pop a
  // native toast. The BEL stays as a generic audible fallback.
  if (!supportsOsc9 && (options.windowsTerminal ?? isWindowsTerminalSession())) {
    const message = formatNotification(notification);
    if (message.length > 0) {
      sendWindowsToast(message);
    }
  }
}

export function formatNotification(notification: TerminalNotification): string {
  const title = sanitizeNotificationText(notification.title);
  const body = sanitizeNotificationText(notification.body ?? '');
  const message =
    title.length > 0 && body.length > 0 ? `${title}: ${body}` : title.length > 0 ? title : body;
  return message.slice(0, MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH);
}

/**
 * Build the OSC/BEL bytes for a terminal notification.
 *
 * - `supportsOsc9 === true`: emit a single OSC 9 sequence — the modern
 *   desktop-notification path used by iTerm2, WezTerm, Kitty, Ghostty
 *   and Warp.
 * - `supportsOsc9 === false`: fall back to a bare BEL so the user still
 *   gets the system bell on terminals that don't recognize OSC 9.
 *
 * When `insideTmux === true` and we're emitting OSC 9, wrap the sequence
 * in a tmux DCS passthrough (`ESC P tmux ; <payload> ESC \`) and double
 * any `ESC` bytes inside the payload — otherwise tmux swallows the OSC.
 * BEL is single-byte and passes through tmux unchanged, so no wrap is
 * needed in the fallback path.
 */
export function buildTerminalNotificationSequences(
  notification: TerminalNotification,
  options: BuildOptions,
): string[] {
  const message = formatNotification(notification);
  if (message.length === 0) return [];
  if (!options.supportsOsc9) {
    return [BEL];
  }
  const osc9 = `${ESC}]9;${message}${BEL}`;
  if (options.insideTmux) {
    const escaped = osc9.replaceAll(ESC, `${ESC}${ESC}`);
    return [`${ESC}Ptmux;${escaped}${ESC}${ST}`];
  }
  return [osc9];
}

/**
 * Best-effort detection of OSC 9 desktop-notification support, driven
 * entirely off well-known environment variables. The allow-list is
 * intentionally short and conservative because BEL is safe everywhere,
 * while shipping OSC 9 to a terminal that doesn't grok it would print
 * escape garbage on screen.
 */
export function supportsOsc9Notification(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env['TERM_PROGRAM'] ?? '';
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'ghostty' ||
    termProgram === 'WarpTerminal'
  ) {
    return true;
  }
  const term = env['TERM'] ?? '';
  if (term === 'xterm-kitty' || term === 'xterm-ghostty') return true;
  return false;
}

/**
 * Best-effort detection of ConEmu-style OSC 9;4 progress support, driven
 * off well-known environment variables like `supportsOsc9Notification`.
 * The two allow-lists must stay separate: iTerm2 posts a desktop
 * notification for ANY `OSC 9;<payload>` it receives, so sending the 9;4
 * progress sequence there pops a "4;3" notification every keepalive tick.
 * Terminals outside this list simply get no progress reporting, which is
 * always safe.
 */
export function supportsTerminalProgress(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env['WT_SESSION'] ?? '').length > 0) return true;
  if (env['ConEmuANSI'] === 'ON') return true;
  const termProgram = env['TERM_PROGRAM'] ?? '';
  if (termProgram === 'ghostty' || termProgram === 'WezTerm') return true;
  const term = env['TERM'] ?? '';
  if (term === 'xterm-ghostty') return true;
  return false;
}

export function isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  const tmux = env['TMUX'] ?? '';
  return tmux.length > 0;
}

/**
 * Detect Windows Terminal via the `WT_SESSION` variable it always sets.
 * Deliberately env-only: under WSL `process.platform` is `linux` but
 * `WT_SESSION` is still inherited and `powershell.exe` works via interop.
 */
export function isWindowsTerminalSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['WT_SESSION'] ?? '').length > 0;
}

const WINDOWS_TOAST_NOTIFIER_ID = 'Kimi Code';

/**
 * Build the `powershell.exe` invocation that pops a native WinRT toast.
 *
 * Ported from pi-notify (MIT, https://github.com/ferologics/pi-notify),
 * with two fixes over the original: the message is single-quote escaped
 * before being interpolated into the script, and the caller swallows all
 * spawn errors (see `sendWindowsToast`). The toast uses the single-text
 * ToastText01 template; `CreateTextNode` escapes XML for us. The notifier
 * id (AUMID) is the fixed string 'Kimi Code', so toasts carry no app
 * registration and no click callback.
 */
export function buildWindowsToastCommand(message: string): { file: string; args: string[] } {
  const type = 'Windows.UI.Notifications';
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const escaped = message.replaceAll("'", "''");
  const script = [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${escaped}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_TOAST_NOTIFIER_ID}').Show([${type}.ToastNotification]::new($xml))`,
  ].join('; ');
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
}

/**
 * Fire-and-forget toast delivery: spawn without waiting, swallow every
 * error (a missing `powershell.exe` must never crash the TUI), and unref
 * the child so it can't keep the process alive.
 */
export function sendWindowsToast(message: string): void {
  try {
    const { file, args } = buildWindowsToastCommand(message);
    const child = execFile(file, args, () => {
      // Intentionally empty: delivery errors are not actionable here.
    });
    child.unref();
  } catch {
    // Notification delivery must never take down the TUI.
  }
}

function sanitizeNotificationText(value: string): string {
  return Array.from(value)
    .map((ch) => (isControlCharacter(ch) ? ' ' : ch))
    .join('')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function isControlCharacter(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}
