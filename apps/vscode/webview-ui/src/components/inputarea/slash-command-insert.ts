interface SlashToken {
  start: number;
}

interface SlashCommandInsertInput {
  text: string;
  cursorPos: number;
  activeToken: SlashToken;
  commandName: string;
}

interface SlashCommandInsertResult {
  text: string;
  cursorPos: number;
}

const COMMAND_PREFIX = "/";
const ARGUMENT_SEPARATOR = " ";
const LEADING_WHITESPACE = /^\s/;

export function computeSlashCommandInsert({
  text,
  cursorPos,
  activeToken,
  commandName,
}: SlashCommandInsertInput): SlashCommandInsertResult {
  const suffix = text.slice(cursorPos);
  const existingSeparator = suffix.match(LEADING_WHITESPACE)?.[0];
  const command = `${COMMAND_PREFIX}${commandName}${existingSeparator ?? ARGUMENT_SEPARATOR}`;
  return {
    text:
      text.slice(0, activeToken.start) +
      command +
      (existingSeparator === undefined ? suffix : suffix.slice(existingSeparator.length)),
    cursorPos: activeToken.start + command.length,
  };
}
