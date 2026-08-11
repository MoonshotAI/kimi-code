// packages/app-core/src/lib/normalizeToolName.ts
// normalizeToolName: fold the many real-world spellings of a tool name into the
// canonical lowercase kind used by the display maps (tool labels, chips, glyphs).
// Daemon tool names arrive verbatim and may be CamelCase (`Read`, `MultiEdit`,
// `WebFetch`, `TodoWrite`) or aliased (`shell`, `fetch`). Without this, those
// names silently fall through to the default glyph / raw-arg summary.

const NAME_ALIASES: Record<string, string> = {
  multiedit: 'multi_edit',
  multiedits: 'multi_edit',
  shell: 'bash',
  run: 'bash',
  exec: 'bash',
  ripgrep: 'grep',
  rg: 'grep',
  find: 'glob',
  fetch: 'web_fetch',
  webfetch: 'web_fetch',
  url_fetch: 'web_fetch',
  urlfetch: 'web_fetch',
  list: 'ls',
  listdir: 'ls',
  list_dir: 'ls',
  todowrite: 'todo',
  todo_write: 'todo',
  todoread: 'todo',
  todolist: 'todo',
  todo_list: 'todo',
  agent: 'task',
  subagent: 'task',
  websearch: 'search',
  web_search: 'search',
  create_goal: 'creategoal',
  get_goal: 'getgoal',
  set_goal_budget: 'setgoalbudget',
  update_goal: 'updategoal',
};

export function normalizeToolName(name: string): string {
  const lower = (name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return NAME_ALIASES[lower] ?? lower;
}
