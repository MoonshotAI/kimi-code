export default {
  label: {
    read: 'Read',
    bash: 'Run',
    edit: 'Edit',
    write: 'Write',
    grep: 'Search',
    glob: 'Find',
    ls: 'List',
    web_fetch: 'Fetch',
    search: 'Search',
    todo: 'Todo',
    task: 'Task',
  },
  chip: {
    lines: '{count} lines',
    results: '{count} results',
    edited: 'edited',
    created: 'created',
    todos: '{count} items',
  },
  group: {
    title: '{count} tool call | {count} tool calls',
    running: 'running',
    error: 'failed',
    done: 'done',
  },
} as const;
