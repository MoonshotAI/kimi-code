// apps/kimi-web/src/lib/slashCommands.ts
// Pure TS — no Vue, no side effects. Slash-command metadata + parsers.

export interface SlashCommand {
  name: string;
  /**
   * Description text. For built-in commands this is an i18n KEY (resolve with
   * t(desc)); for skills (`isSkill`) it is the skill's RAW description, rendered
   * verbatim.
   */
  desc: string;
  /**
   * True for a session skill (not a built-in command). Selecting one activates
   * the skill instead of running an app command, and its `desc` is raw text.
   */
  isSkill?: boolean;
  /**
   * Selecting the item should leave the command in the composer so the user can
   * type the message/argument that follows it.
   */
  acceptsInput?: boolean;
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
  { name: '/swarm',      desc: 'commands.swarm.desc', acceptsInput: true },
  { name: '/goal',       desc: 'commands.goal.desc', acceptsInput: true },
  { name: '/btw',        desc: 'commands.btw.desc', acceptsInput: true },
  { name: '/auto',       desc: 'commands.auto.desc' },
  { name: '/yolo',       desc: 'commands.yolo.desc' },
  { name: '/thinking',   desc: 'commands.thinking.desc' },
  { name: '/compact',    desc: 'commands.compact.desc', acceptsInput: true },
  { name: '/undo',       desc: 'commands.undo.desc' },
  { name: '/fork',       desc: 'commands.fork.desc' },
  { name: '/status',     desc: 'commands.status.desc' },
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
 * Build the full slash-item list: built-in commands followed by the session's
 * skills (each shown as `/<skill-name>`). Skills carry their raw description and
 * an `isSkill` flag so the caller knows to activate rather than run a command.
 */
export function buildSlashItems(
  skills: ReadonlyArray<{ name: string; description: string }> = [],
): SlashCommand[] {
  const skillItems: SlashCommand[] = skills.map((s) => ({
    name: `/${s.name}`,
    desc: s.description,
    isSkill: true,
  }));
  return [...SLASH_COMMANDS, ...skillItems];
}

/**
 * Filter slash items by a query string (case-insensitive substring on the name).
 * If query is empty or just "/", returns all items. Defaults to the built-in
 * commands; pass a merged list (see buildSlashItems) to include skills.
 */
export function filterCommands(
  query: string,
  items: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const q = query.toLowerCase().trim();
  if (q === '' || q === '/') return items;
  return items.filter((c) => c.name.toLowerCase().includes(q));
}
