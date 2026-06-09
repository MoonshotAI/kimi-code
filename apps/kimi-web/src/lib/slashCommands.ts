// apps/kimi-web/src/lib/slashCommands.ts
// Pure TS — no Vue, no side effects. Slash-command metadata + parsers.

export interface SlashCommand {
  name: string;
  /** i18n key for the command description; resolve with t(desc) at render time. */
  desc: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help',       desc: 'commands.help.desc' },
  { name: '/new',        desc: 'commands.new.desc' },
  { name: '/sessions',   desc: 'commands.sessions.desc' },
  { name: '/clear',      desc: 'commands.clear.desc' },
  { name: '/model',      desc: 'commands.model.desc' },
  { name: '/provider',   desc: 'commands.provider.desc' },
  { name: '/login',      desc: 'commands.login.desc' },
  { name: '/permission', desc: 'commands.permission.desc' },
  { name: '/plan',       desc: 'commands.plan.desc' },
  { name: '/auto',       desc: 'commands.auto.desc' },
  { name: '/yolo',       desc: 'commands.yolo.desc' },
  { name: '/thinking',   desc: 'commands.thinking.desc' },
  { name: '/compact',    desc: 'commands.compact.desc' },
  { name: '/status',     desc: 'commands.status.desc' },
  { name: '/undo',       desc: 'commands.undo.desc' },
  { name: '/tasks',      desc: 'commands.tasks.desc' },
];

/**
 * Parse a slash command from the start of the input string.
 * Returns { cmd, arg } if input starts with `/` at line start (no leading whitespace),
 * otherwise returns null.
 *
 * Examples:
 *   "/help"         -> { cmd: "/help", arg: "" }
 *   "/new session"  -> { cmd: "/new", arg: "session" }
 *   "hello /help"   -> null (slash not at line start)
 *   "  /help"       -> null (leading whitespace)
 */
export function parseSlash(input: string): { cmd: string; arg: string } | null {
  if (!input.startsWith('/')) return null;
  // Must start exactly at position 0 (no leading spaces)
  const spaceIdx = input.indexOf(' ');
  if (spaceIdx === -1) {
    return { cmd: input, arg: '' };
  }
  return {
    cmd: input.slice(0, spaceIdx),
    arg: input.slice(spaceIdx + 1),
  };
}

/**
 * Filter SLASH_COMMANDS by a query string.
 * Matches if the command name includes the query (prefix or substring, case-insensitive).
 * If query is empty or just "/", returns all commands.
 */
export function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase().trim();
  if (q === '' || q === '/') return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().includes(q));
}
