import { existsSync } from 'node:fs';

import type { Locator, Page } from '@playwright/test';

import { resolveDefaultShell } from '../../src/main/terminal/manager';
import { binaryName } from '../../src/main/terminal/processes';
import { expect, test as base } from './app';
import { closeSettings, openSettings } from './settings';

export const PROMPT = 'e2e$ ';

export const shellEnv: Record<string, string> = process.platform === 'win32'
  ? {}
  : {
      SHELL: '/bin/sh',
      PS1: PROMPT,
      ENV: '',
      BASH_ENV: '',
      BASH_SILENCE_DEPRECATION_WARNING: '1',
      HISTFILE: '/dev/null',
      PROMPT_COMMAND: '',
    };

export const isWindows = process.platform === 'win32';

export const shellName = isWindows ? binaryName(resolveDefaultShell('win32', process.env, existsSync)) : 'sh';

export const sleepBinary: string | RegExp = isWindows ? /ping/i : 'sleep';

export const shellCommands = isWindows
  ? {
      echo: (text: string) => `Write-Output '${text}'`,
      pwd: '(Get-Location).Path',
      writeFile: (name: string, text: string) => `Set-Content -NoNewline -Path ${name} -Value '${text}'`,
      sleep: (seconds: number) => `ping -n ${seconds + 1} 127.0.0.1 > $null`,
      exit: 'exit',
      shellPid: (tag: string) => `Write-Output "${tag}-pid-$PID"`,
    }
  : {
      echo: (text: string) => `echo ${text}`,
      pwd: 'pwd',
      writeFile: (name: string, text: string) => `printf '%s' '${text}' > ${name}`,
      sleep: (seconds: number) => `sleep ${seconds}`,
      exit: 'exit',
      shellPid: (tag: string) => `echo ${tag}-pid-$$`,
    };

export async function enableTerminalScreenReader(window: Page): Promise<void> {
  const dialog = await openSettings(window, 'About');
  const toggle = dialog.getByRole('switch', { name: 'Terminal screen reader support' });
  if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await closeSettings(window);
}

export const test = base.extend({
  app: async ({ app }, use) => {
    await enableTerminalScreenReader(app.window);
    await use(app);
  },
});

export function terminalPanel(window: Page): Locator {
  return window.getByRole('region', { name: 'Terminal' });
}

export function terminalTabs(window: Page): Locator {
  return terminalPanel(window).getByRole('tablist').getByRole('tab');
}

export function activeScreen(window: Page): Locator {
  return terminalPanel(window).locator('.terminal-host:visible .xterm-screen');
}

export function terminalHost(window: Page): Locator {
  return terminalPanel(window).locator('.terminal-host:visible');
}

export async function screenText(host: Locator): Promise<string> {
  const rows = await host.getByRole('list').getByRole('listitem').allTextContents();
  return rows.map(row => row.replace(/\u00a0/g, ' ').trimEnd()).filter(row => row.length > 0).join('\n');
}

export async function terminalText(window: Page): Promise<string> {
  return screenText(terminalHost(window));
}

export async function expectTerminalText(window: Page, matcher: RegExp | string, timeout = 15_000): Promise<void> {
  await expect.poll(async () => {
    const text = await terminalText(window);
    return typeof matcher === 'string' ? text.includes(matcher) : matcher.test(text);
  }, { message: `waiting for the terminal to show ${String(matcher)}`, timeout }).toBe(true);
}

export async function runInTerminal(window: Page, command: string): Promise<void> {
  await activeScreen(window).click();
  await window.keyboard.type(command);
  await window.keyboard.press('Enter');
}

export async function waitForPrompt(window: Page): Promise<void> {
  if (isWindows) {
    await expectTerminalText(window, /^PS .*>/m, 30_000);
    await runInTerminal(window, "function prompt { 'e2e' + '$ ' }; Clear-Host");
  }
  await expectTerminalText(window, 'e2e$');
}

export async function selectTerminalLine(window: Page, text: string): Promise<void> {
  const exact = new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  const row = terminalHost(window).getByRole('list').getByRole('listitem').filter({ hasText: exact }).last();
  const box = (await row.boundingBox())!;
  await window.mouse.click(box.x + 4, box.y + box.height / 2, { clickCount: 3 });
}

export async function readShellPid(window: Page, tag: string): Promise<string> {
  let pid: string | undefined;
  await expect.poll(async () => {
    const matches = [...(await terminalText(window)).matchAll(new RegExp(`^${tag}-pid-(\\d+)\\s*$`, 'gm'))];
    pid = matches.at(-1)?.[1];
    return pid;
  }, { message: 'waiting for the shell to print its PID' }).toBeDefined();
  return pid!;
}
