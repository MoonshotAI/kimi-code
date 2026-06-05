// Slash-command detection for ACP `session/prompt`.
//
// Copied from the TUI's `apps/kimi-code/src/tui/commands/parse.ts` and the
// skill-resolution slice of `apps/kimi-code/src/tui/commands/resolve.ts`
// (`resolveSkillCommand`). The TUI's resolver also handles builtin slash
// commands and `streaming/compacting` busy gates; ACP does not surface
// those concepts (Zed serializes `session/prompt` requests at the
// transport layer, and TUI builtins like `/clear` are TUI-process-only),
// so this module deliberately only handles the `skill:<name>` form.
//
// Sync target: if the TUI parser's accepted grammar changes (e.g. the
// "no `/` inside name" rule), update the duplicate here too.

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashIntent =
  | { readonly kind: 'skill'; readonly skillName: string; readonly args: string }
  | { readonly kind: 'passthrough' };

export function parseSlashInput(input: string): ParsedSlashInput | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  if (trimmed.length === 0) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  if (name.includes('/')) return null;
  return { name, args };
}

export function resolveSkillCommand(
  skillCommandMap: ReadonlyMap<string, string>,
  commandName: string,
): string | undefined {
  return skillCommandMap.get(commandName) ?? skillCommandMap.get(`skill:${commandName}`);
}

export function detectSlashIntent(
  text: string,
  skillCommandMap: ReadonlyMap<string, string>,
): SlashIntent {
  const parsed = parseSlashInput(text);
  if (parsed === null) return { kind: 'passthrough' };
  const skillName = resolveSkillCommand(skillCommandMap, parsed.name);
  if (skillName === undefined) return { kind: 'passthrough' };
  return { kind: 'skill', skillName, args: parsed.args };
}
