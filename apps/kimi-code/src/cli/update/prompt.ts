import { clearLine, cursorTo, emitKeypressEvents, moveCursor } from 'node:readline';

import chalk from 'chalk';

import { PRODUCT_NAME } from '#/constant/app';
import { HIDE_CURSOR, SHOW_CURSOR } from '#/constant/terminal';
import {
  UPDATE_PROMPT_MUTED,
  UPDATE_PROMPT_PRIMARY,
  UPDATE_PROMPT_SUCCESS,
  UPDATE_PROMPT_TEXT_DIM,
  UPDATE_PROMPT_WARNING,
} from '#/constant/update';

import { type InstallSource, type UpdateTarget } from './types';

const CHANGELOG_URL = 'https://moonshotai.github.io/kimi-code/en/release-notes/changelog.html';

export type InstallPromptChoiceValue = 'install' | 'skip';

export interface InstallPromptChoice {
  readonly value: InstallPromptChoiceValue;
  readonly label: string;
}

export interface InstallPromptOptions {
  readonly currentVersion: string;
  readonly target: UpdateTarget;
  readonly installCommand: string;
  readonly installSource: InstallSource;
  readonly input?: NodeJS.ReadStream;
  readonly output?: NodeJS.WriteStream;
}

const INSTALL_HINT = 'Install update now';
const SKIP_HINT = 'Continue with current version';

export function createInstallPromptChoices(target: UpdateTarget): readonly InstallPromptChoice[] {
  return [
    { value: 'install', label: `${INSTALL_HINT} (${target.version})` },
    { value: 'skip', label: SKIP_HINT },
  ];
}

export function getDefaultInstallPromptSelection(choices: readonly InstallPromptChoice[]): number {
  const installIndex = choices.findIndex((choice) => choice.value === 'install');
  return Math.max(installIndex, 0);
}

export function moveInstallPromptSelection(
  currentIndex: number,
  direction: 'up' | 'down',
  choiceCount: number,
): number {
  if (direction === 'up') {
    return Math.max(0, currentIndex - 1);
  }
  return Math.min(choiceCount - 1, currentIndex + 1);
}

function renderInstallPrompt(
  options: InstallPromptOptions,
  choices: readonly InstallPromptChoice[],
  selectedIndex: number,
): readonly string[] {
  const label = chalk.hex(UPDATE_PROMPT_TEXT_DIM).bold;
  const currentVersion = chalk.hex(UPDATE_PROMPT_WARNING).bold(options.currentVersion);
  const targetVersion = chalk.hex(UPDATE_PROMPT_SUCCESS).bold(options.target.version);
  const sourceLabel = chalk.hex(UPDATE_PROMPT_PRIMARY).bold(options.installSource);
  const command = chalk.hex(UPDATE_PROMPT_PRIMARY)(options.installCommand);
  const changelogText = chalk.hex(UPDATE_PROMPT_PRIMARY).underline(`View changelog: ${CHANGELOG_URL}`);
  const lines = [
    chalk.hex(UPDATE_PROMPT_PRIMARY).bold('Kimi Code Update Available'),
    chalk.hex(UPDATE_PROMPT_MUTED)(`${PRODUCT_NAME} has a newer release ready.`),
    `]8;;${CHANGELOG_URL}\\${changelogText}]8;;\\`,
    '',
    `${label('Current')}  ${currentVersion}`,
    `${label('Target ')}  ${targetVersion}`,
    `${label('Source ')}  ${sourceLabel}`,
    `${label('Command')}  ${command}`,
    '',
    chalk.hex(UPDATE_PROMPT_MUTED)('↑↓ choose · Enter confirm · Esc continue'),
    '',
  ];

  for (let i = 0; i < choices.length; i++) {
    const choice = choices[i];
    if (choice === undefined) continue;
    const isSelected = i === selectedIndex;
    const pointer = isSelected ? '❯' : ' ';
    const content = ` ${pointer} ${choice.label}`;
    if (isSelected) {
      lines.push(chalk.hex(UPDATE_PROMPT_PRIMARY).bold(content));
      continue;
    }
    lines.push(chalk.hex(UPDATE_PROMPT_TEXT_DIM)(content));
  }

  return lines;
}

function writePromptFrame(
  output: NodeJS.WriteStream,
  lines: readonly string[],
  previousLineCount: number,
): number {
  if (previousLineCount > 0) {
    moveCursor(output, 0, -(previousLineCount - 1));
  }

  for (let i = 0; i < lines.length; i++) {
    clearLine(output, 0);
    cursorTo(output, 0);
    output.write(lines[i] ?? '');
    if (i < lines.length - 1) {
      output.write('\n');
    }
  }

  return lines.length;
}

export async function promptForInstallConfirmation(
  options: InstallPromptOptions,
): Promise<boolean> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const choices = createInstallPromptChoices(options.target);
  let selectedIndex = getDefaultInstallPromptSelection(choices);

  return new Promise<boolean>((resolve) => {
    let lineCount = 0;
    const hadRawMode = 'isRaw' in input ? input.isRaw : false;
    const canSetRawMode = typeof input.setRawMode === 'function';

    const cleanup = (): void => {
      input.off('keypress', onKeypress);
      if (canSetRawMode) {
        input.setRawMode(hadRawMode);
      }
      output.write(SHOW_CURSOR);
      output.write('\n');
    };

    const finish = (choice: InstallPromptChoiceValue): void => {
      cleanup();
      resolve(choice === 'install');
    };

    const render = (): void => {
      lineCount = writePromptFrame(
        output,
        renderInstallPrompt(options, choices, selectedIndex),
        lineCount,
      );
    };

    const onKeypress = (_input: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.name === 'up') {
        selectedIndex = moveInstallPromptSelection(selectedIndex, 'up', choices.length);
        render();
        return;
      }
      if (key.name === 'down') {
        selectedIndex = moveInstallPromptSelection(selectedIndex, 'down', choices.length);
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const chosen = choices[selectedIndex]?.value ?? 'skip';
        finish(chosen);
        return;
      }
      if (key.name === 'escape' || (key.ctrl === true && key.name === 'c')) {
        finish('skip');
      }
    };

    emitKeypressEvents(input);
    if (canSetRawMode) {
      input.setRawMode(true);
    }
    input.resume();
    input.on('keypress', onKeypress);
    output.write(HIDE_CURSOR);
    render();
  });
}
