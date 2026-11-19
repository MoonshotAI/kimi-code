
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
  fetchurl: 'web_fetch',
  fetch_url: 'web_fetch',
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
  wait_for: 'waitfor',
  task_list: 'tasklist',
  task_output: 'taskoutput',
  task_stop: 'taskstop',
};

export function normalizeToolName(name: string): string {
  const lower = (name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return NAME_ALIASES[lower] ?? lower;
}
